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
