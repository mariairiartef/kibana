/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { CloudSetup } from '@kbn/cloud-plugin/server';
import {
  Plugin,
  PluginInitializerContext,
  CoreSetup,
  Logger,
  SavedObjectsServiceStart,
  IRouter,
  KibanaRequest,
  DEFAULT_APP_CATEGORIES,
} from '@kbn/core/server';
import { CustomIntegrationsPluginSetup } from '@kbn/custom-integrations-plugin/server';
import { DataPluginStart } from '@kbn/data-plugin/server/plugin';
import { ENTERPRISE_SEARCH_APP_ID } from '@kbn/deeplinks-search';
import { KibanaFeatureScope } from '@kbn/features-plugin/common';
import { FeaturesPluginSetup } from '@kbn/features-plugin/server';
import { GlobalSearchPluginSetup } from '@kbn/global-search-plugin/server';
import type { GuidedOnboardingPluginSetup } from '@kbn/guided-onboarding-plugin/server';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/public';
import { LogsSharedPluginSetup } from '@kbn/logs-shared-plugin/server';
import type { MlPluginSetup } from '@kbn/ml-plugin/server';
import { SearchConnectorsPluginSetup } from '@kbn/search-connectors-plugin/server';
import { SecurityPluginSetup } from '@kbn/security-plugin/server';
import { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { UsageCollectionSetup } from '@kbn/usage-collection-plugin/server';

import {
  ENTERPRISE_SEARCH_OVERVIEW_PLUGIN,
  ENTERPRISE_SEARCH_CONTENT_PLUGIN,
  ELASTICSEARCH_PLUGIN,
  ANALYTICS_PLUGIN,
  APP_SEARCH_PLUGIN,
  WORKPLACE_SEARCH_PLUGIN,
  SEARCH_EXPERIENCES_PLUGIN,
  ENTERPRISE_SEARCH_RELEVANCE_LOGS_SOURCE_ID,
  ENTERPRISE_SEARCH_AUDIT_LOGS_SOURCE_ID,
  ENTERPRISE_SEARCH_ANALYTICS_LOGS_SOURCE_ID,
  VECTOR_SEARCH_PLUGIN,
  SEMANTIC_SEARCH_PLUGIN,
  AI_SEARCH_PLUGIN,
  APPLICATIONS_PLUGIN,
  SEARCH_PRODUCT_NAME,
  SEARCH_RELEVANCE_PLUGIN,
} from '../common/constants';

import {
  appSearchGuideId,
  websiteSearchGuideId,
  databaseSearchGuideId,
  appSearchGuideConfig,
  websiteSearchGuideConfig,
  databaseSearchGuideConfig,
} from '../common/guided_onboarding/search_guide_config';

import { registerTelemetryUsageCollector as registerASTelemetryUsageCollector } from './collectors/app_search/telemetry';
import { registerTelemetryUsageCollector as registerCNTelemetryUsageCollector } from './collectors/connectors/telemetry';
import { registerTelemetryUsageCollector as registerESTelemetryUsageCollector } from './collectors/enterprise_search/telemetry';
import { registerTelemetryUsageCollector as registerWSTelemetryUsageCollector } from './collectors/workplace_search/telemetry';
import { registerEnterpriseSearchIntegrations } from './integrations';

import { checkAccess } from './lib/check_access';
import { entSearchHttpAgent } from './lib/enterprise_search_http_agent';
import {
  EnterpriseSearchRequestHandler,
  IEnterpriseSearchRequestHandler,
} from './lib/enterprise_search_request_handler';

import { registerAppSearchRoutes } from './routes/app_search';
import { registerEnterpriseSearchRoutes } from './routes/enterprise_search';
import { registerAnalyticsRoutes } from './routes/enterprise_search/analytics';
import { registerApiKeysRoutes } from './routes/enterprise_search/api_keys';
import { registerConfigDataRoute } from './routes/enterprise_search/config_data';
import { registerConnectorRoutes } from './routes/enterprise_search/connectors';
import { registerCrawlerRoutes } from './routes/enterprise_search/crawler/crawler';
import { registerStatsRoutes } from './routes/enterprise_search/stats';
import { registerTelemetryRoute } from './routes/enterprise_search/telemetry';
import { registerWorkplaceSearchRoutes } from './routes/workplace_search';

import { appSearchTelemetryType } from './saved_objects/app_search/telemetry';
import { enterpriseSearchTelemetryType } from './saved_objects/enterprise_search/telemetry';
import { workplaceSearchTelemetryType } from './saved_objects/workplace_search/telemetry';

import { GlobalConfigService } from './services/global_config_service';
import { uiSettings as enterpriseSearchUISettings } from './ui_settings';

import { getConnectorsSearchResultProvider } from './utils/connectors_search_result_provider';
import { getIndicesSearchResultProvider } from './utils/indices_search_result_provider';
import { getSearchResultProvider } from './utils/search_result_provider';

import { ConfigType } from '.';

interface PluginsSetup {
  cloud: CloudSetup;
  customIntegrations?: CustomIntegrationsPluginSetup;
  features: FeaturesPluginSetup;
  globalSearch: GlobalSearchPluginSetup;
  guidedOnboarding?: GuidedOnboardingPluginSetup;
  logsShared: LogsSharedPluginSetup;
  ml?: MlPluginSetup;
  licensing: LicensingPluginStart;
  searchConnectors?: SearchConnectorsPluginSetup;
  security: SecurityPluginSetup;
  usageCollection?: UsageCollectionSetup;
}

export interface PluginsStart {
  data: DataPluginStart;
  spaces?: SpacesPluginStart;
}

export interface RouteDependencies {
  config: ConfigType;
  enterpriseSearchRequestHandler: IEnterpriseSearchRequestHandler;
  getSavedObjectsService?(): SavedObjectsServiceStart;
  globalConfigService: GlobalConfigService;
  log: Logger;
  ml?: MlPluginSetup;
  router: IRouter;
}

export class EnterpriseSearchPlugin implements Plugin {
  private readonly config: ConfigType;
  private readonly logger: Logger;
  private readonly globalConfigService: GlobalConfigService;

  /**
   * Exposed services
   */

  constructor(initializerContext: PluginInitializerContext) {
    this.config = initializerContext.config.get<ConfigType>();
    this.globalConfigService = new GlobalConfigService();
    this.logger = initializerContext.logger.get();
  }

  public setup(
    {
      capabilities,
      elasticsearch,
      http,
      savedObjects,
      getStartServices,
      uiSettings,
    }: CoreSetup<PluginsStart>,
    {
      usageCollection,
      security,
      features,
      globalSearch,
      logsShared,
      customIntegrations,
      ml,
      licensing,
      guidedOnboarding,
      cloud,
      searchConnectors,
    }: PluginsSetup
  ) {
    this.globalConfigService.setup(elasticsearch.legacy.config$, cloud);
    const config = this.config;
    const log = this.logger;
    const PLUGIN_IDS = [
      ENTERPRISE_SEARCH_OVERVIEW_PLUGIN.ID,
      ENTERPRISE_SEARCH_CONTENT_PLUGIN.ID,
      ELASTICSEARCH_PLUGIN.ID,
      ANALYTICS_PLUGIN.ID,
      ...(config.canDeployEntSearch ? [APP_SEARCH_PLUGIN.ID, WORKPLACE_SEARCH_PLUGIN.ID] : []),
      SEARCH_EXPERIENCES_PLUGIN.ID,
      VECTOR_SEARCH_PLUGIN.ID,
      SEMANTIC_SEARCH_PLUGIN.ID,
      APPLICATIONS_PLUGIN.ID,
      AI_SEARCH_PLUGIN.ID,
      SEARCH_RELEVANCE_PLUGIN.ID,
    ];
    const isCloud = !!cloud?.cloudId;

    if (customIntegrations) {
      registerEnterpriseSearchIntegrations(config, customIntegrations);
    }

    /*
     * Initialize config.ssl.certificateAuthorities file(s) - required for all API calls (+ access checks)
     */
    entSearchHttpAgent.initializeHttpAgent(config);

    /**
     * Register space/feature control
     */
    features.registerKibanaFeature({
      id: ENTERPRISE_SEARCH_APP_ID,
      name: SEARCH_PRODUCT_NAME,
      order: 0,
      category: DEFAULT_APP_CATEGORIES.enterpriseSearch,
      scope: [KibanaFeatureScope.Spaces, KibanaFeatureScope.Security],
      app: ['kibana', ...PLUGIN_IDS],
      catalogue: PLUGIN_IDS,
      privileges: {
        all: {
          app: ['kibana', ...PLUGIN_IDS],
          api: [],
          catalogue: PLUGIN_IDS,
          savedObject: {
            all: [],
            read: [],
          },
          ui: [],
        },
        read: {
          disabled: true,
          savedObject: {
            all: [],
            read: [],
          },
          ui: [],
        },
      },
    });

    /**
     * Register Enterprise Search UI Settings
     */
    uiSettings.register(enterpriseSearchUISettings);

    /**
     * Register user access to the Enterprise Search plugins
     */
    capabilities.registerSwitcher(
      async (request: KibanaRequest) => {
        const [, { spaces }] = await getStartServices();

        const dependencies = {
          config,
          security,
          spaces,
          request,
          log,
          ml,
        };

        const { hasAppSearchAccess, hasWorkplaceSearchAccess } = await checkAccess(dependencies);

        return {
          navLinks: {
            appSearch: hasAppSearchAccess && config.canDeployEntSearch,
            workplaceSearch: hasWorkplaceSearchAccess && config.canDeployEntSearch,
          },
          catalogue: {
            appSearch: hasAppSearchAccess && config.canDeployEntSearch,
            workplaceSearch: hasWorkplaceSearchAccess && config.canDeployEntSearch,
          },
        };
      },
      {
        capabilityPath: ['navLinks.*', 'catalogue.*'],
      }
    );

    /**
     * Register routes
     */
    const router = http.createRouter();
    const enterpriseSearchRequestHandler = new EnterpriseSearchRequestHandler({ config, log });
    const dependencies = {
      router,
      config,
      globalConfigService: this.globalConfigService,
      log,
      enterpriseSearchRequestHandler,
      ml,
      licensing,
    };

    registerConfigDataRoute(dependencies);
    if (config.canDeployEntSearch) registerAppSearchRoutes(dependencies);
    registerEnterpriseSearchRoutes(dependencies);
    if (config.canDeployEntSearch) registerWorkplaceSearchRoutes(dependencies);
    // Enterprise Search Routes
    if (config.hasConnectors) registerConnectorRoutes(dependencies);
    if (config.hasWebCrawler) registerCrawlerRoutes(dependencies);
    registerStatsRoutes(dependencies);

    // Analytics Routes (stand-alone product)
    void getStartServices().then(([coreStart, { data }]) => {
      registerAnalyticsRoutes({ ...dependencies, data, savedObjects: coreStart.savedObjects });
    });

    registerApiKeysRoutes(dependencies);

    /**
     * Bootstrap the routes, saved objects, and collector for telemetry
     */
    savedObjects.registerType(enterpriseSearchTelemetryType);
    if (config.canDeployEntSearch) {
      savedObjects.registerType(appSearchTelemetryType);
      savedObjects.registerType(workplaceSearchTelemetryType);
    }
    let savedObjectsStarted: SavedObjectsServiceStart;

    void getStartServices().then(([coreStart]) => {
      savedObjectsStarted = coreStart.savedObjects;

      if (usageCollection) {
        registerESTelemetryUsageCollector(usageCollection, savedObjectsStarted, this.logger);
        registerCNTelemetryUsageCollector(usageCollection, this.logger);
        if (config.canDeployEntSearch) {
          registerASTelemetryUsageCollector(usageCollection, savedObjectsStarted, this.logger);
          registerWSTelemetryUsageCollector(usageCollection, savedObjectsStarted, this.logger);
        }
      }
    });
    registerTelemetryRoute({ ...dependencies, getSavedObjectsService: () => savedObjectsStarted });

    /*
     * Register logs source configuration, used by LogStream components
     * @see https://github.com/elastic/kibana/blob/main/x-pack/plugins/observability_solution/logs_shared/public/components/log_stream/log_stream.stories.mdx#with-a-source-configuration
     */
    logsShared.logViews.defineInternalLogView(ENTERPRISE_SEARCH_RELEVANCE_LOGS_SOURCE_ID, {
      logIndices: {
        indexName: 'logs-app_search.search_relevance_suggestions-*',
        type: 'index_name',
      },
      name: 'Enterprise Search Search Relevance Logs',
    });

    logsShared.logViews.defineInternalLogView(ENTERPRISE_SEARCH_AUDIT_LOGS_SOURCE_ID, {
      logIndices: {
        indexName: 'logs-enterprise_search*',
        type: 'index_name',
      },
      name: 'Enterprise Search Audit Logs',
    });

    logsShared.logViews.defineInternalLogView(ENTERPRISE_SEARCH_ANALYTICS_LOGS_SOURCE_ID, {
      logIndices: {
        indexName: 'behavioral_analytics-events-*',
        type: 'index_name',
      },
      name: 'Enterprise Search Behavioral Analytics Logs',
    });

    /**
     * Register a config for the search guide
     */
    if (config.canDeployEntSearch) {
      guidedOnboarding?.registerGuideConfig(appSearchGuideId, appSearchGuideConfig);
    }
    if (config.hasWebCrawler) {
      guidedOnboarding?.registerGuideConfig(websiteSearchGuideId, websiteSearchGuideConfig);
    }
    if (config.hasConnectors) {
      guidedOnboarding?.registerGuideConfig(databaseSearchGuideId, databaseSearchGuideConfig);
    }

    /**
     * Register our integrations in the global search bar
     */

    if (globalSearch) {
      globalSearch.registerResultProvider(
        getSearchResultProvider(
          config,
          searchConnectors?.getConnectorTypes() || [],
          isCloud,
          http.staticAssets.getPluginAssetHref('images/crawler.svg')
        )
      );
      globalSearch.registerResultProvider(getIndicesSearchResultProvider(http.staticAssets));
      globalSearch.registerResultProvider(getConnectorsSearchResultProvider(http.staticAssets));
    }
  }

  public start() {}

  public stop() {}
}
