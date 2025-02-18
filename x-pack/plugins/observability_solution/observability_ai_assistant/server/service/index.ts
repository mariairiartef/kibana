/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server/plugin';
import { createConcreteWriteIndex, getDataStreamAdapter } from '@kbn/alerting-plugin/server';
import type { CoreSetup, CoreStart, KibanaRequest, Logger } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import { getSpaceIdFromPath } from '@kbn/spaces-plugin/common';
import type { TaskManagerSetupContract } from '@kbn/task-manager-plugin/server';
import { once } from 'lodash';
import type { AssistantScope } from '@kbn/ai-assistant-common';
import { ObservabilityAIAssistantScreenContextRequest } from '../../common/types';
import type { ObservabilityAIAssistantPluginStartDependencies } from '../types';
import { ChatFunctionClient } from './chat_function_client';
import { ObservabilityAIAssistantClient } from './client';
import { conversationComponentTemplate } from './conversation_component_template';
import { kbComponentTemplate } from './kb_component_template';
import { KnowledgeBaseService } from './knowledge_base_service';
import type { RegistrationCallback, RespondFunctionResources } from './types';

function getResourceName(resource: string) {
  return `.kibana-observability-ai-assistant-${resource}`;
}

export const resourceNames = {
  componentTemplate: {
    conversations: getResourceName('component-template-conversations'),
    kb: getResourceName('component-template-kb'),
  },
  aliases: {
    conversations: getResourceName('conversations'),
    kb: getResourceName('kb'),
  },
  indexPatterns: {
    conversations: getResourceName('conversations*'),
    kb: getResourceName('kb*'),
  },
  indexTemplate: {
    conversations: getResourceName('index-template-conversations'),
    kb: getResourceName('index-template-kb'),
  },
  pipelines: {
    kb: getResourceName('kb-ingest-pipeline'),
  },
};

export class ObservabilityAIAssistantService {
  private readonly core: CoreSetup<ObservabilityAIAssistantPluginStartDependencies>;
  private readonly logger: Logger;
  private readonly getModelId: () => Promise<string>;
  public kbService?: KnowledgeBaseService;
  private enableKnowledgeBase: boolean;

  private readonly registrations: RegistrationCallback[] = [];

  constructor({
    logger,
    core,
    taskManager,
    getModelId,
    enableKnowledgeBase,
  }: {
    logger: Logger;
    core: CoreSetup<ObservabilityAIAssistantPluginStartDependencies>;
    taskManager: TaskManagerSetupContract;
    getModelId: () => Promise<string>;
    enableKnowledgeBase: boolean;
  }) {
    this.core = core;
    this.logger = logger;
    this.getModelId = getModelId;
    this.enableKnowledgeBase = enableKnowledgeBase;

    this.allowInit();
  }

  getKnowledgeBaseStatus() {
    return this.init().then(() => {
      return this.kbService!.status();
    });
  }

  init = async () => {};

  private allowInit = () => {
    this.init = once(async () => {
      return this.doInit().catch((error) => {
        this.allowInit();
        throw error;
      });
    });
  };

  private doInit = async () => {
    try {
      const [coreStart, pluginsStart] = await this.core.getStartServices();

      const elserModelId = await this.getModelId();

      const esClient = coreStart.elasticsearch.client;
      await esClient.asInternalUser.cluster.putComponentTemplate({
        create: false,
        name: resourceNames.componentTemplate.conversations,
        template: conversationComponentTemplate,
      });

      await esClient.asInternalUser.indices.putIndexTemplate({
        name: resourceNames.indexTemplate.conversations,
        composed_of: [resourceNames.componentTemplate.conversations],
        create: false,
        index_patterns: [resourceNames.indexPatterns.conversations],
        template: {
          settings: {
            number_of_shards: 1,
            auto_expand_replicas: '0-1',
            hidden: true,
          },
          mappings: {
            _meta: {
              model: elserModelId,
            },
          },
        },
      });

      const conversationAliasName = resourceNames.aliases.conversations;

      await createConcreteWriteIndex({
        esClient: esClient.asInternalUser,
        logger: this.logger,
        totalFieldsLimit: 10000,
        indexPatterns: {
          alias: conversationAliasName,
          pattern: `${conversationAliasName}*`,
          basePattern: `${conversationAliasName}*`,
          name: `${conversationAliasName}-000001`,
          template: resourceNames.indexTemplate.conversations,
        },
        dataStreamAdapter: getDataStreamAdapter({ useDataStreamForAlerts: false }),
      });

      await esClient.asInternalUser.cluster.putComponentTemplate({
        create: false,
        name: resourceNames.componentTemplate.kb,
        template: kbComponentTemplate,
      });

      await esClient.asInternalUser.ingest.putPipeline({
        id: resourceNames.pipelines.kb,
        processors: [
          {
            inference: {
              model_id: elserModelId,
              target_field: 'ml',
              field_map: {
                text: 'text_field',
              },
              inference_config: {
                // @ts-expect-error
                text_expansion: {
                  results_field: 'tokens',
                },
              },
            },
          },
        ],
      });

      await esClient.asInternalUser.indices.putIndexTemplate({
        name: resourceNames.indexTemplate.kb,
        composed_of: [resourceNames.componentTemplate.kb],
        create: false,
        index_patterns: [resourceNames.indexPatterns.kb],
        template: {
          settings: {
            number_of_shards: 1,
            auto_expand_replicas: '0-1',
            hidden: true,
          },
        },
      });

      const kbAliasName = resourceNames.aliases.kb;

      await createConcreteWriteIndex({
        esClient: esClient.asInternalUser,
        logger: this.logger,
        totalFieldsLimit: 10000,
        indexPatterns: {
          alias: kbAliasName,
          pattern: `${kbAliasName}*`,
          basePattern: `${kbAliasName}*`,
          name: `${kbAliasName}-000001`,
          template: resourceNames.indexTemplate.kb,
        },
        dataStreamAdapter: getDataStreamAdapter({ useDataStreamForAlerts: false }),
      });

      this.kbService = new KnowledgeBaseService({
        logger: this.logger.get('kb'),
        esClient,
        taskManagerStart: pluginsStart.taskManager,
        getModelId: this.getModelId,
        enabled: this.enableKnowledgeBase,
      });

      this.logger.info('Successfully set up index assets');
    } catch (error) {
      this.logger.error(`Failed to initialize service: ${error.message}`);
      this.logger.debug(error);
      throw error;
    }
  };

  async getClient({
    request,
    scopes,
  }: {
    request: KibanaRequest;
    scopes?: AssistantScope[];
  }): Promise<ObservabilityAIAssistantClient> {
    const controller = new AbortController();

    request.events.aborted$.subscribe(() => {
      controller.abort();
    });

    const [_, [coreStart, plugins]] = await Promise.all([
      this.init(),
      this.core.getStartServices() as Promise<
        [CoreStart, { security: SecurityPluginStart; actions: ActionsPluginStart }, unknown]
      >,
    ]);
    // user will not be found when executed from system connector context
    const user = plugins.security.authc.getCurrentUser(request);

    const soClient = coreStart.savedObjects.getScopedClient(request);

    const basePath = coreStart.http.basePath.get(request);

    const { spaceId } = getSpaceIdFromPath(basePath, coreStart.http.basePath.serverBasePath);

    return new ObservabilityAIAssistantClient({
      actionsClient: await plugins.actions.getActionsClientWithRequest(request),
      uiSettingsClient: coreStart.uiSettings.asScopedToClient(soClient),
      namespace: spaceId,
      esClient: {
        asInternalUser: coreStart.elasticsearch.client.asInternalUser,
        asCurrentUser: coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
      },
      logger: this.logger,
      user: user
        ? {
            id: user.profile_uid,
            name: user.username,
          }
        : undefined,
      knowledgeBaseService: this.kbService!,
      scopes: scopes || ['all'],
    });
  }

  async getFunctionClient({
    screenContexts,
    signal,
    resources,
    client,
    scopes,
  }: {
    screenContexts: ObservabilityAIAssistantScreenContextRequest[];
    signal: AbortSignal;
    resources: RespondFunctionResources;
    client: ObservabilityAIAssistantClient;
    scopes: AssistantScope[];
  }): Promise<ChatFunctionClient> {
    const fnClient = new ChatFunctionClient(screenContexts);

    const params = {
      signal,
      functions: fnClient,
      resources,
      client,
      scopes,
    };

    await Promise.all(
      this.registrations.map((fn) =>
        fn(params).catch((error) => {
          this.logger.error(`Error registering functions`);
          this.logger.error(error);
        })
      )
    );

    return fnClient;
  }

  register(cb: RegistrationCallback) {
    this.registrations.push(cb);
  }
}
