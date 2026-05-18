/**
 * B.Tech lateral (2-1): admission number may be 2026xxxx while academic batch is prior year (2025).
 */

export const deriveAdmissionSeriesYear = (admissionNumber) => {
  const m = String(admissionNumber ?? '').trim().match(/^(20\d{2})/);
  return m ? m[1] : null;
};

const pickFourDigitYear = (...vals) => {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (/^(19|20)\d{2}$/.test(s)) return s;
  }
  return null;
};

/** True when registration extras indicate lateral entry (2-1 / prior intake year). */
export const isLateralRegistrationExtras = (registrationExtras, admissionNumber) => {
  if (!registrationExtras || typeof registrationExtras !== 'object') return false;

  const seriesYear = deriveAdmissionSeriesYear(admissionNumber);
  const seriesNum = Number(seriesYear);

  const status = String(
    registrationExtras.student_status ?? registrationExtras.studentStatus ?? ''
  ).trim();
  if (/lateral/i.test(status)) return true;

  const sem = String(
    registrationExtras.semester ??
      registrationExtras.current_semester ??
      registrationExtras.currentSemester ??
      registrationExtras.semister ??
      ''
  ).trim();
  if (sem === '2-1') return true;

  const intake = Number(
    String(
      registrationExtras.current_year ??
        registrationExtras.currentYear ??
        registrationExtras.academic_year ??
        registrationExtras.academicYear ??
        ''
    ).trim()
  );
  if (Number.isFinite(seriesNum) && Number.isFinite(intake) && intake === seriesNum - 1) {
    return true;
  }

  return false;
};

/**
 * Expected `students.batch` for secondary sync / backfill.
 * Lateral → prior intake year (e.g. 2025); regular → series year or extras batch.
 */
export const resolveExpectedBatchYear = (registrationExtras, admissionNumber) => {
  const seriesYear = deriveAdmissionSeriesYear(admissionNumber);
  const lateral = isLateralRegistrationExtras(registrationExtras, admissionNumber);

  if (lateral) {
    return (
      pickFourDigitYear(
        registrationExtras?.current_year,
        registrationExtras?.currentYear,
        registrationExtras?.batch,
        registrationExtras?.academic_year,
        registrationExtras?.academicYear
      ) ?? (seriesYear ? String(Number(seriesYear) - 1) : null)
    );
  }

  return (
    pickFourDigitYear(
      registrationExtras?.batch,
      registrationExtras?.academic_year,
      registrationExtras?.academicYear,
      registrationExtras?.current_year,
      registrationExtras?.currentYear
    ) ?? seriesYear
  );
};

/**
 * Secondary `students.current_year` is year-of-study (1–12), not calendar intake year.
 * Derive from semester token (e.g. 2-1 → 2) when present.
 */
export const resolveSecondaryYearOfStudy = (registrationExtras) => {
  const sem = String(
    registrationExtras?.semester ??
      registrationExtras?.current_semester ??
      registrationExtras?.currentSemester ??
      registrationExtras?.semister ??
      ''
  ).trim();
  const head = sem.match(/^(\d+)\s*[-/]/);
  if (head) {
    const y = Number.parseInt(head[1], 10);
    if (Number.isFinite(y) && y >= 1 && y <= 12) return y;
  }
  const raw = Number.parseInt(
    String(registrationExtras?.current_year ?? registrationExtras?.currentYear ?? '').trim(),
    10
  );
  if (Number.isFinite(raw) && raw >= 1 && raw <= 12) return raw;
  return null;
};
