/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { format } from 'url';
import request from 'superagent';
import type {
  APIReturnType,
  APIClientRequestParamsOf,
} from '@kbn/apm-plugin/public/services/rest/create_call_apm_api';
import { APIEndpoint } from '@kbn/apm-plugin/server';
import { formatRequest } from '@kbn/server-route-repository';
import { RoleCredentials } from '@kbn/ftr-common-functional-services';
import type { DeploymentAgnosticFtrProviderContext } from '../ftr_provider_context';

const INTERNAL_API_REGEX = /^\S+\s(\/)?internal\/[^\s]*$/;

type InternalApi = `${string} /internal/${string}`;
interface ExternalEndpointParams {
  roleAuthc: RoleCredentials;
}

type Options<TEndpoint extends APIEndpoint> = (TEndpoint extends InternalApi
  ? {}
  : ExternalEndpointParams) & {
  type?: 'form-data';
  endpoint: TEndpoint;
  spaceId?: string;
} & APIClientRequestParamsOf<TEndpoint> & {
    params?: { query?: { _inspect?: boolean } };
  };

function isPublicApi<TEndpoint extends APIEndpoint>(
  options: Options<TEndpoint>
): options is Options<TEndpoint> & ExternalEndpointParams {
  return !INTERNAL_API_REGEX.test(options.endpoint);
}

function createApmApiClient({ getService }: DeploymentAgnosticFtrProviderContext, role: string) {
  const supertestWithoutAuth = getService('supertestWithoutAuth');
  const samlAuth = getService('samlAuth');
  const logger = getService('log');

  return async <TEndpoint extends APIEndpoint>(
    options: Options<TEndpoint>
  ): Promise<SupertestReturnType<TEndpoint>> => {
    const { endpoint, type } = options;

    const params = 'params' in options ? (options.params as Record<string, any>) : {};

    const credentials = isPublicApi(options)
      ? options.roleAuthc.apiKeyHeader
      : await samlAuth.getM2MApiCookieCredentialsWithRoleScope(role);

    const headers: Record<string, string> = {
      ...samlAuth.getInternalRequestHeader(),
      ...credentials,
    };

    const { method, pathname, version } = formatRequest(endpoint, params.path);
    const pathnameWithSpaceId = options.spaceId ? `/s/${options.spaceId}${pathname}` : pathname;
    const url = format({ pathname: pathnameWithSpaceId, query: params?.query });

    logger.debug(`Calling APM API: ${method.toUpperCase()} ${url}`);

    if (version) {
      headers['Elastic-Api-Version'] = version;
    }

    let res: request.Response;
    if (type === 'form-data') {
      const fields: Array<[string, any]> = Object.entries(params.body);
      const formDataRequest = supertestWithoutAuth[method](url)
        .set(headers)
        .set('Content-type', 'multipart/form-data');

      for (const field of fields) {
        void formDataRequest.field(field[0], field[1]);
      }

      res = await formDataRequest;
    } else if (params.body) {
      res = await supertestWithoutAuth[method](url).send(params.body).set(headers);
    } else {
      res = await supertestWithoutAuth[method](url).set(headers);
    }

    // supertest doesn't throw on http errors
    if (res?.status !== 200) {
      throw new ApmApiError(res, endpoint);
    }

    return res;
  };
}

type ApiErrorResponse = Omit<request.Response, 'body'> & {
  body: {
    statusCode: number;
    error: string;
    message: string;
    attributes: object;
  };
};

export type ApmApiSupertest = ReturnType<typeof createApmApiClient>;

export class ApmApiError extends Error {
  res: ApiErrorResponse;

  constructor(res: request.Response, endpoint: string) {
    super(
      `Unhandled ApmApiError.
Status: "${res.status}"
Endpoint: "${endpoint}"
Body: ${JSON.stringify(res.body)}`
    );

    this.res = res;
  }
}

export interface SupertestReturnType<TEndpoint extends APIEndpoint> {
  status: number;
  body: APIReturnType<TEndpoint>;
}

export function ApmApiProvider(context: DeploymentAgnosticFtrProviderContext) {
  return {
    readUser: createApmApiClient(context, 'viewer'),
    adminUser: createApmApiClient(context, 'admin'),
    writeUser: createApmApiClient(context, 'editor'),
  };
}
