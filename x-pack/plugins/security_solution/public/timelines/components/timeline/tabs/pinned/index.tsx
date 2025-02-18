/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isEmpty } from 'lodash/fp';
import React, { useMemo, useCallback, memo } from 'react';
import type { ConnectedProps } from 'react-redux';
import { connect } from 'react-redux';
import deepEqual from 'fast-deep-equal';
import type { EuiDataGridControlColumn } from '@elastic/eui';
import { useExpandableFlyoutApi } from '@kbn/expandable-flyout';
import type { RunTimeMappings } from '@kbn/timelines-plugin/common/search_strategy';
import {
  DocumentDetailsLeftPanelKey,
  DocumentDetailsRightPanelKey,
} from '../../../../../flyout/document_details/shared/constants/panel_keys';
import { useKibana } from '../../../../../common/lib/kibana';
import { timelineSelectors } from '../../../../store';
import type { Direction } from '../../../../../../common/search_strategy';
import { useTimelineEvents } from '../../../../containers';
import { requiredFieldsForActions } from '../../../../../detections/components/alerts_table/default_config';
import { SourcererScopeName } from '../../../../../sourcerer/store/model';
import { timelineDefaults } from '../../../../store/defaults';
import { useIsExperimentalFeatureEnabled } from '../../../../../common/hooks/use_experimental_features';
import { useSourcererDataView } from '../../../../../sourcerer/containers';
import type { TimelineModel } from '../../../../store/model';
import type { State } from '../../../../../common/store';
import { TimelineTabs } from '../../../../../../common/types/timeline';
import { UnifiedTimelineBody } from '../../body/unified_timeline_body';
import type { TimelineTabCommonProps } from '../shared/types';
import { useTimelineColumns } from '../shared/use_timeline_columns';
import { useTimelineControlColumn } from '../shared/use_timeline_control_columns';
import { LeftPanelNotesTab } from '../../../../../flyout/document_details/left';
import { useNotesInFlyout } from '../../properties/use_notes_in_flyout';
import { NotesFlyout } from '../../properties/notes_flyout';
import { defaultUdtHeaders } from '../../body/column_headers/default_headers';

interface PinnedFilter {
  bool: {
    should: Array<{ match_phrase: { _id: string } }>;
    minimum_should_match: number;
  };
}

export type Props = TimelineTabCommonProps & PropsFromRedux;

const rowDetailColumn = [
  {
    id: 'row-details',
    columnHeaderType: 'not-filtered',
    width: 0,
    headerCellRender: () => null,
    rowCellRender: () => null,
  },
];

export const PinnedTabContentComponent: React.FC<Props> = ({
  columns,
  timelineId,
  itemsPerPage,
  itemsPerPageOptions,
  pinnedEventIds,
  rowRenderers,
  sort,
  eventIdToNoteIds,
}) => {
  const { telemetry } = useKibana().services;
  const { dataViewId, sourcererDataView, selectedPatterns } = useSourcererDataView(
    SourcererScopeName.timeline
  );

  const filterQuery = useMemo(() => {
    if (isEmpty(pinnedEventIds)) {
      return '';
    }
    const filterObj = Object.entries(pinnedEventIds).reduce<PinnedFilter>(
      (acc, [pinnedId, isPinned]) => {
        if (isPinned) {
          return {
            ...acc,
            bool: {
              ...acc.bool,
              should: [
                ...acc.bool.should,
                {
                  match_phrase: {
                    _id: pinnedId,
                  },
                },
              ],
            },
          };
        }
        return acc;
      },
      {
        bool: {
          should: [],
          minimum_should_match: 1,
        },
      }
    );
    try {
      return JSON.stringify(filterObj);
    } catch {
      return '';
    }
  }, [pinnedEventIds]);

  const timelineQueryFields = useMemo(() => {
    const columnsHeader = isEmpty(columns) ? defaultUdtHeaders : columns;
    const columnFields = columnsHeader.map((c) => c.id);

    return [...columnFields, ...requiredFieldsForActions];
  }, [columns]);

  const timelineQuerySortField = useMemo(
    () =>
      sort.map(({ columnId, columnType, esTypes, sortDirection }) => ({
        field: columnId,
        type: columnType,
        direction: sortDirection as Direction,
        esTypes: esTypes ?? [],
      })),
    [sort]
  );
  const { augmentedColumnHeaders } = useTimelineColumns(columns);

  const [queryLoadingState, { events, totalCount, pageInfo, loadPage, refreshedAt, refetch }] =
    useTimelineEvents({
      endDate: '',
      id: `pinned-${timelineId}`,
      indexNames: selectedPatterns,
      dataViewId,
      fields: timelineQueryFields,
      limit: itemsPerPage,
      filterQuery,
      runtimeMappings: sourcererDataView.runtimeFieldMap as RunTimeMappings,
      skip: filterQuery === '',
      startDate: '',
      sort: timelineQuerySortField,
      timerangeKind: undefined,
    });

  const { openFlyout } = useExpandableFlyoutApi();
  const securitySolutionNotesDisabled = useIsExperimentalFeatureEnabled(
    'securitySolutionNotesDisabled'
  );

  const {
    associateNote,
    notes,
    isNotesFlyoutVisible,
    closeNotesFlyout,
    showNotesFlyout,
    eventId: noteEventId,
    setNotesEventId,
  } = useNotesInFlyout({
    eventIdToNoteIds,
    refetch,
    timelineId,
    activeTab: TimelineTabs.pinned,
  });

  const onToggleShowNotes = useCallback(
    (eventId?: string) => {
      const indexName = selectedPatterns.join(',');
      if (eventId && !securitySolutionNotesDisabled) {
        openFlyout({
          right: {
            id: DocumentDetailsRightPanelKey,
            params: {
              id: eventId,
              indexName,
              scopeId: timelineId,
            },
          },
          left: {
            id: DocumentDetailsLeftPanelKey,
            path: {
              tab: LeftPanelNotesTab,
            },
            params: {
              id: eventId,
              indexName,
              scopeId: timelineId,
            },
          },
        });
        telemetry.reportOpenNoteInExpandableFlyoutClicked({
          location: timelineId,
        });
        telemetry.reportDetailsFlyoutOpened({
          location: timelineId,
          panel: 'left',
        });
      } else {
        if (eventId) {
          setNotesEventId(eventId);
          showNotesFlyout();
        }
      }
    },
    [
      openFlyout,
      securitySolutionNotesDisabled,
      selectedPatterns,
      telemetry,
      timelineId,
      setNotesEventId,
      showNotesFlyout,
    ]
  );

  const leadingControlColumns = useTimelineControlColumn({
    columns,
    sort,
    timelineId,
    activeTab: TimelineTabs.pinned,
    refetch,
    events,
    pinnedEventIds,
    eventIdToNoteIds,
    onToggleShowNotes,
  });

  const NotesFlyoutMemo = useMemo(() => {
    return (
      <NotesFlyout
        associateNote={associateNote}
        eventId={noteEventId}
        show={isNotesFlyoutVisible}
        notes={notes}
        onClose={closeNotesFlyout}
        onCancel={closeNotesFlyout}
        timelineId={timelineId}
      />
    );
  }, [associateNote, closeNotesFlyout, isNotesFlyoutVisible, noteEventId, notes, timelineId]);

  return (
    <>
      {NotesFlyoutMemo}
      <UnifiedTimelineBody
        header={<></>}
        columns={augmentedColumnHeaders}
        rowRenderers={rowRenderers}
        timelineId={timelineId}
        itemsPerPage={itemsPerPage}
        itemsPerPageOptions={itemsPerPageOptions}
        sort={sort}
        events={events}
        refetch={refetch}
        dataLoadingState={queryLoadingState}
        totalCount={totalCount}
        onChangePage={loadPage}
        activeTab={TimelineTabs.pinned}
        updatedAt={refreshedAt}
        isTextBasedQuery={false}
        pageInfo={pageInfo}
        leadingControlColumns={leadingControlColumns as EuiDataGridControlColumn[]}
        trailingControlColumns={rowDetailColumn}
      />
    </>
  );
};

const makeMapStateToProps = () => {
  const getTimeline = timelineSelectors.getTimelineByIdSelector();
  const mapStateToProps = (state: State, { timelineId }: TimelineTabCommonProps) => {
    const timeline: TimelineModel = getTimeline(state, timelineId) ?? timelineDefaults;
    const { columns, itemsPerPage, itemsPerPageOptions, pinnedEventIds, sort, eventIdToNoteIds } =
      timeline;

    return {
      columns,
      timelineId,
      itemsPerPage,
      itemsPerPageOptions,
      pinnedEventIds,
      sort,
      eventIdToNoteIds,
    };
  };
  return mapStateToProps;
};

const connector = connect(makeMapStateToProps);

type PropsFromRedux = ConnectedProps<typeof connector>;

const PinnedTabContent = connector(
  memo(
    PinnedTabContentComponent,
    (prevProps, nextProps) =>
      prevProps.itemsPerPage === nextProps.itemsPerPage &&
      prevProps.timelineId === nextProps.timelineId &&
      deepEqual(prevProps.columns, nextProps.columns) &&
      deepEqual(prevProps.eventIdToNoteIds, nextProps.eventIdToNoteIds) &&
      deepEqual(prevProps.itemsPerPageOptions, nextProps.itemsPerPageOptions) &&
      deepEqual(prevProps.pinnedEventIds, nextProps.pinnedEventIds) &&
      deepEqual(prevProps.sort, nextProps.sort)
  )
);

// eslint-disable-next-line import/no-default-export
export { PinnedTabContent as default };
