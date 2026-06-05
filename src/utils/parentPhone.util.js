/** Normalize to last 10 digits (Indian mobile). */
export const normalizeMobileDigits = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits.length > 0 ? digits : '';
};

/**
 * When joining/admission father_phone equals student_phone but the lead has a
 * different father_phone, prefer the lead's father number.
 */
export const reconcileFatherPhoneFromLead = ({
  studentPhone,
  fatherPhone,
  leadFatherPhone,
  leadAlternateMobile,
}) => {
  const student = normalizeMobileDigits(studentPhone);
  const father = normalizeMobileDigits(fatherPhone);
  const leadFather = normalizeMobileDigits(leadFatherPhone);

  if (student.length !== 10) {
    return String(fatherPhone ?? '').trim();
  }
  if (father.length === 10 && father !== student) {
    return String(fatherPhone ?? '').trim();
  }
  if (leadFather.length === 10 && leadFather !== student) {
    return leadFather;
  }
  return String(fatherPhone ?? '').trim();
};

/** Preferred SMS/contact: distinct father, else distinct mother, else father, mother, student. */
export const suggestPreferredMobileDigits = (studentPhone, fatherPhone, motherPhone) => {
  const student = normalizeMobileDigits(studentPhone);
  const father = normalizeMobileDigits(fatherPhone);
  const mother = normalizeMobileDigits(motherPhone);
  if (father.length === 10 && father !== student) return father;
  if (mother.length === 10 && mother !== student) return mother;
  if (father.length === 10) return father;
  if (mother.length === 10) return mother;
  if (student.length === 10) return student;
  return '';
};

/**
 * Father/mother mobiles for post-approval SMS: distinct 10-digit numbers,
 * excluding the student/preferred contact line (avoids duplicate sends).
 */
export const collectParentSmsRecipients = ({
  studentContactPhone,
  fatherPhone,
  motherPhone,
}) => {
  const studentLine = normalizeMobileDigits(studentContactPhone);
  const seen = new Set();
  const out = [];

  for (const raw of [fatherPhone, motherPhone]) {
    const digits = normalizeMobileDigits(raw);
    if (digits.length !== 10) continue;
    if (studentLine.length === 10 && digits === studentLine) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push(digits);
  }

  return out;
};

/** @deprecated Use collectParentSmsRecipients */
export const collectParentPortalSmsRecipients = collectParentSmsRecipients;

/**
 * Student/preferred line plus parent lines — for admission confirmation SMS on approval.
 */
export const collectAdmissionConfirmationSmsRecipients = ({
  studentContactPhone,
  fatherPhone,
  motherPhone,
}) => {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const digits = normalizeMobileDigits(raw);
    if (digits.length !== 10 || seen.has(digits)) return;
    seen.add(digits);
    out.push(digits);
  };
  add(studentContactPhone);
  for (const digits of collectParentSmsRecipients({
    studentContactPhone,
    fatherPhone,
    motherPhone,
  })) {
    add(digits);
  }
  return out;
};
