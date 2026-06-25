/**
 * Registration-form keys for parent portrait uploads on the joining flow.
 * Values are typically `data:image/jpeg;base64,...` from the joining page file inputs,
 * or occasionally a plain URL / filename string.
 */

export const FATHER_PHOTO_REG_KEYS = [
  'father_photo',
  'fatherphoto',
  'fathers_photo',
  'fathersphoto',
  'father_picture',
  'fatherpicture',
  'parent_father_photo',
  'father_portrait',
  'fatherportrait',
];

export const MOTHER_PHOTO_REG_KEYS = [
  'mother_photo',
  'motherphoto',
  'mothers_photo',
  'mothersphoto',
  'mother_picture',
  'motherpicture',
  'parent_mother_photo',
  'mother_portrait',
  'motherportrait',
];

export const STUDENT_PHOTO_REG_KEYS = [
  'student_photo',
  'studentphoto',
  'student_picture',
  'studentpicture',
  'student_portrait',
  'studentportrait',
  'applicant_photo',
  'applicantphoto',
  'applicant_picture',
  'applicantpicture',
  'passport_photo',
  'passportphoto',
  'profile_photo',
  'profilephoto',
];

function pickFromRegistrationFormData(registrationFormData, keys) {
  if (!registrationFormData || typeof registrationFormData !== 'object') return '';
  const want = new Set(keys.map((k) => String(k).toLowerCase()));
  for (const [k, v] of Object.entries(registrationFormData)) {
    if (!want.has(String(k).toLowerCase())) continue;
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/** Resolve student / father / mother portrait values from registration extras. */
export function extractPortraitPhotosFromRegistrationFormData(registrationFormData) {
  const studentRaw = pickFromRegistrationFormData(registrationFormData, STUDENT_PHOTO_REG_KEYS);
  const fatherRaw = pickFromRegistrationFormData(registrationFormData, FATHER_PHOTO_REG_KEYS);
  const motherRaw = pickFromRegistrationFormData(registrationFormData, MOTHER_PHOTO_REG_KEYS);
  return {
    studentPhoto: studentRaw ? studentRaw : null,
    fatherPhoto: fatherRaw ? fatherRaw : null,
    motherPhoto: motherRaw ? motherRaw : null,
  };
}

/** True when a registration patch carries portrait upload fields (retake / gallery). */
export function registrationPatchIncludesPortraitFields(patch) {
  if (!patch || typeof patch !== 'object') return false;
  return Object.keys(patch).some((k) => {
    const n = k.toLowerCase();
    return n.includes('photo') || n.includes('portrait') || n.includes('picture');
  });
}
