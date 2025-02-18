/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { Client } from '@elastic/elasticsearch';
import {
  ESDocumentWithOperation,
  Fields,
  SynthtraceESAction,
  SynthtraceGenerator,
} from '@kbn/apm-synthtrace-client';
import { castArray, isFunction } from 'lodash';
import { Readable, Transform } from 'stream';
import { isGeneratorObject } from 'util/types';
import { Logger } from '../utils/create_logger';
import { sequential } from '../utils/stream_utils';

export interface SynthtraceEsClientOptions {
  concurrency?: number;
  refreshAfterIndex?: boolean;
  pipeline: (base: Readable) => NodeJS.WritableStream;
}

type MaybeArray<T> = T | T[];

export class SynthtraceEsClient<TFields extends Fields> {
  protected readonly client: Client;
  protected readonly logger: Logger;

  private readonly concurrency: number;
  private readonly refreshAfterIndex: boolean;

  private pipelineCallback: (base: Readable) => NodeJS.WritableStream;
  protected dataStreams: string[] = [];
  protected indices: string[] = [];

  constructor(options: { client: Client; logger: Logger } & SynthtraceEsClientOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.concurrency = options.concurrency ?? 1;
    this.refreshAfterIndex = options.refreshAfterIndex ?? false;
    this.pipelineCallback = options.pipeline;
  }

  async clean() {
    this.logger.info(`Cleaning data streams: "${this.dataStreams.join(',')}"`);

    const resolvedIndices = this.indices.length
      ? (
          await this.client.indices.resolveIndex({
            name: this.indices.join(','),
            expand_wildcards: ['open', 'hidden'],
            // @ts-expect-error ignore_unavailable is not in the type definition, but it is accepted by es
            ignore_unavailable: true,
          })
        ).indices.map((index: { name: string }) => index.name)
      : [];

    if (resolvedIndices.length) {
      this.logger.info(`Cleaning indices: "${resolvedIndices.join(',')}"`);
    }

    await Promise.all([
      ...(this.dataStreams.length
        ? [
            this.client.indices.deleteDataStream({
              name: this.dataStreams.join(','),
              expand_wildcards: ['open', 'hidden'],
            }),
          ]
        : []),
      ...(resolvedIndices.length
        ? [
            this.client.indices.delete({
              index: resolvedIndices.join(','),
              expand_wildcards: ['open', 'hidden'],
              ignore_unavailable: true,
              allow_no_indices: true,
            }),
          ]
        : []),
    ]);
  }

  async refresh() {
    const allIndices = this.dataStreams.concat(this.indices);
    this.logger.info(`Refreshing "${allIndices.join(',')}"`);

    return this.client.indices.refresh({
      index: allIndices,
      allow_no_indices: true,
      ignore_unavailable: true,
      expand_wildcards: ['open', 'hidden'],
    });
  }

  pipeline(cb: (base: Readable) => NodeJS.WritableStream) {
    this.pipelineCallback = cb;
  }

  async index(
    streamOrGenerator: MaybeArray<Readable | SynthtraceGenerator<TFields>>,
    pipelineCallback?: (base: Readable) => NodeJS.WritableStream
  ) {
    this.logger.debug(`Bulk indexing ${castArray(streamOrGenerator).length} stream(s)`);

    const previousPipelineCallback = this.pipelineCallback;
    if (isFunction(pipelineCallback)) {
      this.pipeline(pipelineCallback);
    }

    const allStreams = castArray(streamOrGenerator).map((obj) => {
      const base = isGeneratorObject(obj) ? Readable.from(obj) : obj;

      return this.pipelineCallback(base);
    }) as Transform[];

    let count: number = 0;

    const stream = sequential(...allStreams);

    await this.client.helpers.bulk({
      concurrency: this.concurrency,
      refresh: false,
      refreshOnCompletion: false,
      flushBytes: 250000,
      datasource: stream,
      filter_path: 'errors,items.*.error,items.*.status',
      onDocument: (doc: ESDocumentWithOperation<TFields>) => {
        let action: SynthtraceESAction;
        count++;

        if (count % 100000 === 0) {
          this.logger.info(`Indexed ${count} documents`);
        } else if (count % 1000 === 0) {
          this.logger.debug(`Indexed ${count} documents`);
        }

        if (doc._action) {
          action = doc._action!;
          delete doc._action;
        } else if (doc._index) {
          action = { create: { _index: doc._index } };
          delete doc._index;
        } else {
          this.logger.debug(doc);
          throw new Error(
            `Could not determine operation: _index and _action not defined in document`
          );
        }

        return action;
      },
      onDrop: (doc) => {
        this.logger.error(`Dropped document: ${JSON.stringify(doc, null, 2)}`);
      },
    });

    this.logger.info(`Produced ${count} events`);

    // restore pipeline callback
    if (pipelineCallback) {
      this.pipeline(previousPipelineCallback);
    }

    if (this.refreshAfterIndex) {
      await this.refresh();
    }
  }
}
