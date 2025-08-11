function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) {
      return _json({ status: 'error', message: 'No post data received' });
    }

    const data = JSON.parse(e.postData.contents);

    const {
      customerId,
      firstName,
      lastName,
      phoneNumber,
      email,
      status,
      booked,
      split,
      leadSource,
      leadDate,
      lastSent,
      notes
    } = data;

    // ---- get Lead Log sheet explicitly
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Lead Log');
    if (!sheet) return _json({ status: 'error', message: 'Lead Log sheet not found' });

    // ---- sanitize helpers
    const digits = (s) => (s || '').toString().replace(/\D/g, '');
    const phoneDigits = digits(phoneNumber);
    const emailLower = (email || '').toString().trim().toLowerCase();

    // ---- duplicate check (by normalized phone or lowercased email)
    const allRows = sheet.getDataRange().getValues();
    for (let i = 1; i < allRows.length; i++) {
      const row = allRows[i];
      const existingId    = row[0]; // A
      const existingFirst = row[1]; // B
      const existingLast  = row[2]; // C
      const existingPhone = digits(row[3]);                  // D normalized
      const existingEmail = (row[4] || '').toString().toLowerCase(); // E lowercased

      const phoneMatch = phoneDigits && existingPhone && existingPhone === phoneDigits;
      const emailMatch = emailLower && existingEmail && existingEmail === emailLower;
      if (phoneMatch || emailMatch) {
        return _json({
          status: 'duplicate',
          customerId: existingId,
          message: `Duplicate lead found: ${existingFirst} ${existingLast} (#${existingId})`
        });
      }
    }

    // ---- defaults
    const tz = Session.getScriptTimeZone();
    const now = new Date();
    const todayYmd = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

    const newCustomerId = customerId || generateCustomerId(firstName, lastName);
    const leadDateObj = leadDate ? new Date(leadDate) : now;

    // compute Follow Up days (inclusive, excluding Sundays)
    const followUpDays = computeDaysExcludingSundays_(leadDateObj, now);

    // ---- append row
    const newRow = [
      newCustomerId,                     // A ID
      firstName || '',                   // B First Name
      lastName || '',                    // C Last Name
      phoneDigits || '',                 // D Phone (raw digits)
      emailLower || '',                  // E Email
      status || 'No Contact',            // F Status
      booked === true,                   // G Booked (boolean)
      split === true,                    // H Split (boolean)
      leadSource || '',                  // I Lead Source
      leadDate || todayYmd,              // J Lead Date (ISO string)
      '=TODAY()',                        // K Current Date (formula)
      followUpDays,                      // L Follow Up Date (days since lead date, excl. Sundays)
      lastSent || '',                    // M Last Sent
      notes || ''                        // N Notes
    ];

    sheet.appendRow(newRow);

    return _json({
      status: 'success',
      customerId: newCustomerId,
      message: `Lead added successfully — Customer #${newCustomerId}`
    });

  } catch (err) {
    return _json({ status: 'error', message: err.message });
  }
}

function generateCustomerId(firstName, lastName) {
  const initials = ((firstName?.[0] || 'X') + (lastName?.[0] || 'X')).toUpperCase();
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `${initials} - ${randomNum}`;
}

function computeDaysExcludingSundays_(startDate, endDate) {
  if (!(startDate instanceof Date) || isNaN(startDate)) return '';
  if (!(endDate   instanceof Date) || isNaN(endDate))   return '';
  const a = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const b = new Date(endDate.getFullYear(),   endDate.getMonth(),   endDate.getDate());
  let count = 0;
  while (a <= b) {
    if (a.getDay() !== 0) count++; // exclude Sunday (0)
    a.setDate(a.getDate() + 1);
  }
  return count;
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
