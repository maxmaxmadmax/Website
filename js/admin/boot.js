/* SOUNDZGOOD ADMIN - boot.js
   The one module: brings in the helper modules and hands what the admin files use to the page.
   admin.html loads this first, then js/admin/core.js and the feature files. */
import { firebaseConfig, functionsRegion, eventId as defaultEventId, isFirebaseConfigured } from '../site/firebase-config.js?v=873';
import { sysDraftFrom, systemPanelHtml, wireSystemPanel, sysSummary } from './system-builder.js?v=873';
import { stockUsage, pickItems, jobRange } from './stock.js?v=873';
import { pipelineHtml, wirePipeline } from './sales-pipeline.js?v=873';
import { messagesHtml, wireMessages, sendReminder } from './messages.js?v=873';
import { sponsorDirHtml, wireSponsorDir } from './sponsor-directory.js?v=873';
import { dashboardHtml, dashboardData, openRegularNights } from './dashboard.js?v=873';
import { eventHubHtml, eventGroup, BUDGET_STARTER, eventCardHtml, eventFigures, timelineHtml, FAQ_STANDARD } from './event-hub.js?v=873';
import { expandKit } from './kit.js?v=873';

Object.assign(window, {
    firebaseConfig,
    functionsRegion,
    defaultEventId,
    isFirebaseConfigured,
    sysDraftFrom,
    systemPanelHtml,
    wireSystemPanel,
    sysSummary,
    stockUsage,
    pickItems,
    jobRange,
    pipelineHtml,
    wirePipeline,
    messagesHtml,
    wireMessages,
    sendReminder,
    sponsorDirHtml,
    wireSponsorDir,
    dashboardHtml,
    dashboardData,
    openRegularNights,
    eventHubHtml,
    eventGroup,
    BUDGET_STARTER,
    eventCardHtml,
    eventFigures,
    timelineHtml,
    FAQ_STANDARD,
    expandKit
});
