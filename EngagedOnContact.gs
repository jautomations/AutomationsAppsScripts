/** DonnaEngagedOnContact (namespaced, safe alongside other scripts) **/
var DonnaEOC = this.DonnaEOC || (this.DonnaEOC = {});

/***** CONFIG (namespaced to avoid global clashes) *****/
DonnaEOC.LEADS_SHEET_NAME = DonnaEOC.LEADS_SHEET_NAME || 'Lead Log';   // tab name
DonnaEOC.COMMS_SHEET_NAME = DonnaEOC.COMMS_SHEET_NAME || 'Comms Log';  // tab name

DonnaEOC.COL = DonnaEOC.COL || {
  STATUS: 6,      // F = Status
  PHONE_E164: 17  // Q = Phone (E.164 normalized)
};

// Only these events will trigger "Engaged" status
DonnaEOC.EVENT_WHITELIST = DonnaEOC.EVENT_WHITELIST || new Set([
  'message.received',
  'message.delivered',
  'message.created',
  'call.completed',
  'call.ended'
]);

/***** MAIN FUNCTION *****/
/**
 * Scan the Comms Log for recent activity with "No Contact" leads
 * and update them to "Engaged".
 */
function updateEngagementFromComms() {
  const ss     = SpreadsheetApp.getActive();
  const leads  = ss.getSheetByName(DonnaEOC.LEADS_SHEET_NAME);
  const comms  = ss.getSheetByName(DonnaEOC.COMMS_SHEET_NAME);
  const COL    = DonnaEOC.COL;
  const ALLOW  = DonnaEOC.EVENT_WHITELIST;

  if (!leads || !comms) {
    console.error(`❌ Missing sheet(s): Leads = ${!!leads}, Comms = ${!!comms}`);
    return;
  }

  const leadsLastRow = leads.getLastRow();
  if (leadsLastRow < 2) return;

  // Build phone -> row for leads currently "No Contact"
  const phoneVals  = leads.getRange(2, COL.PHONE_E164, leadsLastRow - 1, 1).getValues(); // Q
  const statusVals = leads.getRange(2, COL.STATUS,    leadsLastRow - 1, 1).getValues();   // F
  const phoneToRow = new Map();

  for (let i = 0; i < phoneVals.length; i++) {
    const phone  = (phoneVals[i][0]  || '').toString().trim();
    const status = (statusVals[i][0] || '').toString().trim().toLowerCase();
    if (phone && status === 'no contact') phoneToRow.set(phone, i + 2);
  }
  if (phoneToRow.size === 0) return;

  // Check Comms Log (A Timestamp, B Event Type, F Phone E.164)
  const commsLastRow = comms.getLastRow();
  if (commsLastRow < 2) return;

  const tsVals   = comms.getRange(2, 1, commsLastRow - 1, 1).getValues(); // A
  const typeVals = comms.getRange(2, 2, commsLastRow - 1, 1).getValues(); // B
  const phVals   = comms.getRange(2, 6, commsLastRow - 1, 1).getValues(); // F

  const now = new Date();
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // last 7 days
  const engagedPhones = new Set();

  for (let i = 0; i < tsVals.length; i++) {
    const type  = (typeVals[i][0] || '').toString().trim();
    if (!ALLOW.has(type)) continue;

    const phone = (phVals[i][0] || '').toString().trim();
    if (!phone || !phoneToRow.has(phone)) continue;

    const rawTs = tsVals[i][0];
    const ts = rawTs instanceof Date ? rawTs : new Date(rawTs);
    if (isNaN(ts)) continue;

    if (ts >= cutoff) engagedPhones.add(phone);
  }

  // Update matching leads to "Engaged"
  engagedPhones.forEach(phone => {
    const row = phoneToRow.get(phone);
    if (row) {
      leads.getRange(row, COL.STATUS).setValue('Engaged');
      console.log(`✅ Set row ${row} (${phone}) to Engaged`);
    }
  });
}

/***** TRIGGERS *****/
/**
 * Install a trigger to check for engagement updates every 2 minutes.
 */
function installEngagementWatcher() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'updateEngagementFromComms')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('updateEngagementFromComms')
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log('⏱ Engagement watcher installed: runs every 2 minutes');
}
