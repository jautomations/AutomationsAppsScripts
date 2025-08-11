/***** DONNA LOOKUP PLUS – WEB HANDLER
 * Paste this ENTIRE file into your Apps Script project
 * and deploy as a Web App (Execute as: Me, Access: Anyone).
 *
 * Endpoints (examples):
 *   ?action=lead.search&q=Rachel
 *   ?action=lead.overview&q=Rachel Green
 *   ?action=saveADeal
 *   ?action=tasks.today
 *   ?action=notes.add&text=Talk%20to%20Peter...&tags=Talk%20to%20Peter&id=ID%20-%201234
 *   ?action=notes.search&q=Talk%20to%20Peter
 *   ?action=calendar.create&title=Delivery...&start=2025-08-10T15:00:00-06:00&end=2025-08-10T16:00:00-06:00
 ******************************************************/

/***** PROJECT CONFIG *****/
// Your Automations spreadsheet (explicit so we don’t depend on externals)
const SS_ID = '1MimqbFgN2PpnAvEXBxGqqOEwTCKjLWcXsLEXYDZWms4';

// Tabs (must match your sheet)
const LEADS_SHEET = 'Lead Log';
const COMMS_SHEET = 'Comms Log';
const NOTES_SHEET = 'General Notes';

// Calendar: SPAC
const SPAC_CALENDAR_ID = '5d07e758da607524452232adab8c92fd7012ac98f166319de823de62b2e1fa40@group.calendar.google.com';

// Lead Log columns (1-based) — if these names exist globally we’ll use them; otherwise we’ll infer
const COL = {
  ID: 1, FIRST: 2, LAST: 3, PHONE: 4, EMAIL: 5, STATUS: 6, BOOKED: 7, SPLIT: 8,
  SOURCE: 9, LEAD_DATE: 10, TODAY: 11, DAY_INDEX: 12, LAST_SENT: 13, NOTES: 14,
  LAST_CONTACT: 15, ATTEMPTS_7D: 16, PHONE_E164: 17, LAST_CHANNEL: 18,
  LAST_DIRECTION: 19, LAST_SNIPPET: 20, HAS_TRANSCRIPT: 21
};

// These event types count as a "touch"
const EVENT_TOUCH = new Set([
  'message.received','message.delivered','message.created','call.completed','call.ended'
]);

// Simple heuristics for parsing tasks and “waiting on”
const TASK_MARKERS   = /\b(?:todo|task|follow ?up|send|call|text|email)\b/i;
const WAITING_MARKERS = /\b(?:waiting for|need from|pending|awaiting)\b/i;

// Calendar lookahead for lead.overview (days)
const CAL_LOOKAHEAD_DAYS = 30;


/***** PUBLIC ROUTER *****/
function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = (p.action || '').trim();
  if (!action) return json_(err("Missing 'action' parameter"));

  try {
    switch (action) {
      case 'lead.overview': {
        const res = leadOverview_({
          id: p.id, phone: p.phone, email: p.email, name: p.name, q: p.q
        });
        return json_(ok(res));
      }
      case 'notes.add': {
        const res = notesAdd_({ text: p.text, tags: p.tags, relatedId: p.id });
        return json_(ok(res));
      }
      case 'notes.search': {
        const res = notesSearch_({ q: p.q, tag: p.tag });
        return json_(ok({ results: res }));
      }
      case 'lead.search': {
        const res = leadSearch_((p.q || '').trim());
        return json_(ok({ results: res }));
      }
      case 'lead.listByStatus': {
        const res = leadsByStatus_((p.status || '').trim());
        return json_(ok({ status: p.status, results: res }));
      }
      case 'saveADeal': {
        const res = saveADeal_();
        return json_(ok({ results: res }));
      }
      case 'tasks.today': {
        const res = tasksToday_();
        return json_(ok(res));
      }
      case 'calendar.create': {
        const title = (p.title || '').trim();
        const start = new Date(p.start);
        const end   = new Date(p.end);
        const description = (p.description || '').trim();
        const location    = (p.location || '').trim();
        const guests      = (p.guests || '')
          .split(',').map(s => s.trim()).filter(Boolean);
        const ev = createSpacEvent_({ title, start, end, description, location, guests });
        return json_(ok(ev));
      }
      default:
        return json_(err(`Unknown action: ${action}`));
    }
  } catch (ex) {
    return json_(err(ex && ex.message ? ex.message : String(ex)));
  }
}


/***** FEATURE 1: Lead Overview *****/
function leadOverview_({ id, phone, email, name, q }) {
  const lead = leadGet_({ id, phone, email, name, q });
  if (!lead) return null;

  const comms = commsThread_(lead.phone || lead.phoneRaw, 25);
  const lastTouch = comms.length ? comms[0] : null;

  const noteBlobs = [String(lead.notes || ''), ...comms.map(c => String(c.snippet || ''))].filter(Boolean);
  const tasks = extractTasks_(noteBlobs);
  const waitingOn = extractWaiting_(noteBlobs);

  const upcomingEvents = findCalendarEventsRelatedToLead_(lead, CAL_LOOKAHEAD_DAYS);

  return { lead, lastTouch, tasks, waitingOn, upcomingEvents, recentComms: comms };
}


/***** FEATURE 2: General Notes add/search *****/
function notesAdd_({ text, tags, relatedId }) {
  if (!text || !text.trim()) return { inserted: false, reason: 'Empty text' };
  const ss = SpreadsheetApp.openById(SS_ID);
  let sh = ss.getSheetByName(NOTES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(NOTES_SHEET);
    sh.getRange(1,1,1,5).setValues([['Timestamp','Tags','Text','RelatedID','Author']]);
  }
  const row = [new Date(), (tags||'').trim(), text.trim(), (relatedId||'').trim(), Session.getActiveUser().getEmail() || ''];
  sh.appendRow(row);
  return { inserted: true, row: sh.getLastRow() };
}

function notesSearch_({ q, tag }) {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = ss.getSheetByName(NOTES_SHEET);
  if (!sh) return [];
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];

  const needle = (q||'').toLowerCase();
  const tagNeedle = (tag||'').toLowerCase();

  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const [ts, tags, text, relatedId, author] = vals[i];
    const tagsL = String(tags||'').toLowerCase();
    const textL = String(text||'').toLowerCase();

    const matchesQ   = needle ? (textL.includes(needle) || tagsL.includes(needle)) : true;
    const matchesTag = tag    ? tagsL.includes(tagNeedle) : true;

    if (matchesQ && matchesTag) {
      out.push({ timestamp: ts, tags, text, relatedId, author });
    }
  }
  return out;
}


/***** FEATURE 3: Save-a-Deal pool *****/
function saveADeal_() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = ss.getSheetByName(LEADS_SHEET);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const COLX = inferCOL_(sh);

  const rows = vals.slice(1).map((r,i)=>({row:i+2,data:r}));
  const out = [];

  for (const rec of rows) {
    const d = rec.data;
    const status = (d[COLX.STATUS-1]||'').toString().trim().toLowerCase();
    const booked = !!d[COLX.BOOKED-1];
    const split  = !!d[COLX.SPLIT-1];
    const delivered = status === 'delivered';

    const skip = (status === 'no contact') || (status === 'engaged') || (delivered && booked && split);
    if (skip) continue;

    const lead = formatLeadRow_(rec, COLX);
    const comms = commsThread_(lead.phone || lead.phoneRaw, 10);
    const noteBlobs = [String(lead.notes||''), ...comms.map(c=>String(c.snippet||''))].filter(Boolean);
    const tasks = extractTasks_(noteBlobs);
    const waitingOn = extractWaiting_(noteBlobs);

    out.push({
      lead,
      tasks,
      waitingOn,
      lastTouch: comms.length ? comms[0] : null
    });
  }

  return out;
}


/***** FEATURE 4: Tasks for Today *****/
function tasksToday_() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = ss.getSheetByName(LEADS_SHEET);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return { tasksByLead: [], calendarToday: [] };
  const COLX = inferCOL_(sh);

  const leads = vals.slice(1).map((r,i)=>formatLeadRow_({row:i+2,data:r}, COLX));
  const tasks = [];

  for (const lead of leads) {
    const comms = commsThread_(lead.phone || lead.phoneRaw, 10);
    const blobs = [String(lead.notes||''), ...comms.map(c=>String(c.snippet||''))].filter(Boolean);
    const extracted = extractTasks_(blobs);

    // Basic “due today” heuristic: contains “today” or has no explicit date pattern
    const dueToday = extracted.filter(t => /\btoday\b/i.test(t) ||
      !/\b(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}\/\d{1,2})\b/i.test(t));

    if (dueToday.length) {
      tasks.push({ lead, tasks: dueToday });
    }
  }

  // Today’s calendar events that match any lead
  const calEvents = findCalendarEventsForLeads_(leads, 0); // today only
  return { tasksByLead: tasks, calendarToday: calEvents };
}


/***** LOOKUPS *****/
function leadGet_({ q, id, phone, email, name }) {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = ss.getSheetByName(LEADS_SHEET);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return null;
  const COLX = inferCOL_(sh);
  const rows = vals.slice(1).map((r,i)=>({row:i+2, data:r}));

  // exact ID
  if (id) {
    const hit = rows.find(r => String(r.data[COLX.ID-1]).trim() === id.trim());
    if (hit) return formatLeadRow_(hit, COLX);
  }

  // phone (normalize)
  const e164 = normalizePhone_(phone || q);
  if (e164) {
    const hit = rows.find(r =>
      String(r.data[COLX.PHONE_E164-1]||'').trim() === e164 ||
      String(r.data[COLX.PHONE-1]||'').replace(/\D/g,'') === e164.replace(/\D/g,'')
    );
    if (hit) return formatLeadRow_(hit, COLX);
  }

  // email
  const em = (email || q || '').toLowerCase();
  if (em) {
    const hit = rows.find(r => String(r.data[COLX.EMAIL-1]||'').toLowerCase() === em);
    if (hit) return formatLeadRow_(hit, COLX);
  }

  // name contains
  const needle = (name || q || '').toLowerCase();
  if (needle) {
    const hit = rows.find(r =>
      String(r.data[COLX.FIRST-1]||'').toLowerCase().includes(needle) ||
      String(r.data[COLX.LAST-1]||'').toLowerCase().includes(needle)
    );
    if (hit) return formatLeadRow_(hit, COLX);
  }

  return null;
}

function leadSearch_(q) {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = ss.getSheetByName(LEADS_SHEET);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const COLX = inferCOL_(sh);
  const rows = vals.slice(1).map((r,i)=>({row:i+2, data:r}));

  const needle = (q||'').toLowerCase();
  if (!needle) return [];

  return rows.filter(rec => {
    const d = rec.data;
    return [
      d[COLX.ID-1], d[COLX.FIRST-1], d[COLX.LAST-1],
      d[COLX.EMAIL-1], d[COLX.PHONE-1], d[COLX.NOTES-1]
    ].some(v => String(v||'').toLowerCase().includes(needle));
  }).map(r => formatLeadRow_(r, COLX));
}

function leadsByStatus_(status) {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = ss.getSheetByName(LEADS_SHEET);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const COLX = inferCOL_(sh);
  const rows = vals.slice(1).map((r,i)=>({row:i+2,data:r}));
  const needle = (status||'').toLowerCase();
  return rows.filter(r => String(r.data[COLX.STATUS-1]||'').toLowerCase() === needle)
             .map(r => formatLeadRow_(r, COLX));
}

function commsThread_(phone, limit) {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = ss.getSheetByName(COMMS_SHEET);
  if (!sh) return [];

  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];

  const e164 = normalizePhone_(phone);
  const rows = vals.slice(1).filter(r => String(r[5]||'').trim() === e164); // F=Phone (E.164)

  // newest first
  rows.sort((a,b) => {
    const ta = (a[0] instanceof Date) ? a[0] : new Date(a[0]);
    const tb = (b[0] instanceof Date) ? b[0] : new Date(b[0]);
    return tb - ta;
  });

  const n = Math.max(1, limit|0);
  return rows.slice(0, n).map(r => ({
    timestamp: r[0],             // A Timestamp
    type: r[1],                  // B Event Type
    direction: r[2] || '',       // C Direction (if present)
    phone: r[5],                 // F Phone E.164
    snippet: r[7] || '',         // H Message Snippet
    transcript: r[8] || '',      // I Transcript (full) if present
    eventId: r[15] || r[16] || ''// P/Q Event ID depending on layout
  }));
}


/***** PARSERS *****/
function extractTasks_(texts) {
  const out = [];
  for (const blob of texts) {
    const lines = String(blob).split(/\r?\n/);
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      if (TASK_MARKERS.test(t) || /^\s*[-*]\s*\[?\s*\]?\s+/i.test(t)) {
        out.push(t);
      }
    }
  }
  return dedupe_(out);
}

function extractWaiting_(texts) {
  const out = [];
  for (const blob of texts) {
    const lines = String(blob).split(/\r?\n/);
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      if (WAITING_MARKERS.test(t)) out.push(t);
    }
  }
  return dedupe_(out);
}

function dedupe_(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const key = s.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}


/***** CALENDAR (SPAC) *****/
function spacCalendar_() {
  return CalendarApp.getCalendarById(SPAC_CALENDAR_ID);
}

function findCalendarEventsRelatedToLead_(lead, lookaheadDays) {
  const cal = spacCalendar_();
  if (!cal) return [];
  const now = new Date();
  const end = new Date(now.getTime() + (lookaheadDays * 24*60*60*1000));
  const events = cal.getEvents(now, end);

  const needles = new Set([
    String(lead.id || ''),
    `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
    String(lead.email || '')
  ].filter(Boolean).map(s => s.toLowerCase()));

  const out = [];
  for (const ev of events) {
    const title = ev.getTitle() || '';
    const desc = ev.getDescription() || '';
    const hay = (title + ' ' + desc).toLowerCase();
    if ([...needles].some(n => n && hay.includes(n))) {
      out.push({
        title: title,
        start: ev.getStartTime(),
        end: ev.getEndTime(),
        description: desc,
        location: ev.getLocation() || ''
      });
    }
  }
  return out;
}

function findCalendarEventsForLeads_(leads, lookaheadDays) {
  const cal = spacCalendar_();
  if (!cal) return [];
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // today 00:00
  const end = new Date(start.getTime() + (Math.max(0, lookaheadDays) + 1) * 24*60*60*1000);
  const events = cal.getEvents(start, end);

  const out = [];
  for (const ev of events) {
    const title = ev.getTitle() || '';
    const desc = ev.getDescription() || '';
    const hay = (title + ' ' + desc).toLowerCase();
    const match = leads.find(ld => {
      const keys = [
        String(ld.id || ''),
        `${ld.firstName || ''} ${ld.lastName || ''}`.trim(),
        String(ld.email || '')
      ].filter(Boolean).map(s => s.toLowerCase());
      return keys.some(k => k && hay.includes(k));
    });
    if (match) {
      out.push({
        leadId: match.id, title, start: ev.getStartTime(),
        end: ev.getEndTime(), description: desc, location: ev.getLocation() || ''
      });
    }
  }
  return out;
}

function createSpacEvent_({ title, start, end, description, location, guests }) {
  const cal = spacCalendar_();
  if (!cal) throw new Error('SPAC calendar not found');
  if (!(start instanceof Date) || !(end instanceof Date) || isNaN(start) || isNaN(end)) {
    throw new Error('start/end must be valid Date values');
  }
  const event = cal.createEvent(title || 'Untitled', start, end, {
    description: description || '',
    location: location || ''
  });
  (guests || []).forEach(email => { try { if (email) event.addGuest(email); } catch (_) {} });
  return {
    id: event.getId(),
    title: event.getTitle(),
    start: event.getStartTime(),
    end: event.getEndTime(),
    htmlLink: event.getHtmlLink()
  };
}


/***** FORMAT + UTIL *****/
function formatLeadRow_(rec, COLX) {
  const d = rec.data;
  return {
    row: rec.row,
    id: d[COLX.ID - 1],
    firstName: d[COLX.FIRST - 1],
    lastName: d[COLX.LAST - 1],
    phoneRaw: d[COLX.PHONE - 1],
    phone: d[COLX.PHONE_E164 - 1] || normalizePhone_(d[COLX.PHONE - 1]),
    email: d[COLX.EMAIL - 1],
    status: d[COLX.STATUS - 1],
    booked: !!d[COLX.BOOKED - 1],
    split: !!d[COLX.SPLIT - 1],
    leadSource: d[COLX.SOURCE - 1],
    leadDate: d[COLX.LEAD_DATE - 1],
    followUpIndex: d[COLX.DAY_INDEX - 1],
    lastSent: d[COLX.LAST_SENT - 1],
    lastContact: d[COLX.LAST_CONTACT - 1],
    attempts7d: d[COLX.ATTEMPTS_7D - 1] || 0,
    lastChannel: d[COLX.LAST_CHANNEL - 1],
    lastDirection: d[COLX.LAST_DIRECTION - 1],
    lastSnippet: d[COLX.LAST_SNIPPET - 1],
    hasTranscript: !!d[COLX.HAS_TRANSCRIPT - 1],
    notes: d[COLX.NOTES - 1] || ''
  };
}

function normalizePhone_(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g,'');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits; // fallback
}

// Build COL indices from headers if a global COL isn’t trusted/available
function inferCOL_(sheet) {
  // If this file’s COL exists, use it
  if (COL && COL.ID) return COL;

  const header = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(String);
  const idx = name => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase()) + 1;
  return {
    ID: idx('#') || idx('id'),
    FIRST: idx('first name'),
    LAST: idx('last name'),
    PHONE: idx('phone number'),
    EMAIL: idx('email'),
    STATUS: idx('status'),
    BOOKED: idx('booked'),
    SPLIT: idx('split'),
    SOURCE: idx('lead source'),
    LEAD_DATE: idx('lead date'),
    TODAY: idx('current date'),
    DAY_INDEX: idx('follow up date'),
    LAST_SENT: idx('last sent'),
    NOTES: idx('notes'),
    LAST_CONTACT: idx('last contact date') || idx('last contact'),
    ATTEMPTS_7D: idx('attempts (7d)') || idx('attempts 7d'),
    PHONE_E164: idx('phone (e.164)') || idx('phone'),
    LAST_CHANNEL: idx('last channel'),
    LAST_DIRECTION: idx('last direction'),
    LAST_SNIPPET: idx('last snippet'),
    HAS_TRANSCRIPT: idx('has transcripts') || idx('has transcript')
  };
}


/***** JSON helpers *****/
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function ok(data)  { return { ok: true,  data }; }
function err(message) { return { ok: false, error: message }; }
