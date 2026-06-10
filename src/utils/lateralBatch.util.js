/**
 * B.Tech lateral (2-1): admission number may be 2026xxxx while academic batch is prior year (2025).
 */

export const deriveAdmissionSeriesYear = (admissionNumber) => {
  const m = String(admissionNumber ?? '').trim().match(/^(20\d{2})/);
  return m ? m[1] : null;
};

/** Undergraduate B.Tech (not M.Tech). */
export const isBtechCourseName = (name) => {
  const s = String(name ?? '').trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (/\bm\.?\s*tech\b/i.test(low)) return false;
  if (/\bb\.?\s*tech\b/i.test(low)) return true;
  return /\bbtech\b/i.test(low.replace(/\s+/g, ''));
};

/** Display label for B.Tech lateral batch rows (idempotent if suffix already present). */
export const formatBtechCourseDisplayName = (courseName, isLateral) => {
  const base = String(courseName ?? '').trim();
  if (!base || !isLateral) return base;
  // Collapse any pre-existing duplicates and ensure single suffix.
  if (/\(lateral\)/i.test(base)) {
    return base.replace(/(\s*\(\s*lateral\s*\))+$/gi, ' (LATERAL)').trim();
  }
  return `${base} (LATERAL)`;
};

export const resolveBtechCourseDisplayName = (courseName, registrationExtras, admissionNumber) => {
  const base = String(courseName ?? '').trim();
  if (!base) return '';
  if (!isBtechCourseName(base)) return base;
  return formatBtechCourseDisplayName(
    base,
    isLateralRegistrationExtras(registrationExtras, admissionNumber)
  );
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
    const seriesNum = Number(seriesYear);
    const fromExtras = pickFourDigitYear(
      registrationExtras?.batch,
      registrationExtras?.academic_year,
      registrationExtras?.academicYear,
      registrationExtras?.current_year,
      registrationExtras?.currentYear
    );
    if (fromExtras && Number.isFinite(seriesNum)) {
      const n = Number(fromExtras);
      if (n === seriesNum - 1) return String(n);
      // Extras sometimes store admission-cycle year (2026) instead of intake batch (2025).
      if (n === seriesNum) return String(seriesNum - 1);
    }
    return seriesYear ? String(seriesNum - 1) : null;
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

/** Build lateral-track SQL for `admissions` rows (`''` or `'a'` table alias). */
export const buildSqlBtechLateralTrack = (tableAlias = '') => {
  const p = tableAlias ? `${tableAlias}.` : '';
  const sqlJoiningRegistrationExtras = `COALESCE(
  CASE
    WHEN JSON_VALID(${p}lead_data)
      AND JSON_TYPE(JSON_EXTRACT(${p}lead_data, '$._joiningRegistrationExtras')) = 'OBJECT'
    THEN JSON_EXTRACT(${p}lead_data, '$._joiningRegistrationExtras')
    ELSE JSON_OBJECT()
  END,
  JSON_OBJECT()
)`;

  const sqlRegStudentStatus = `NULLIF(TRIM(COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.student_status')),
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.studentStatus')),
  ''
)), '')`;

  const sqlRegSemester = `NULLIF(TRIM(COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.semester')),
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.current_semester')),
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.currentSemester')),
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.semister')),
  ''
)), '')`;

  const sqlRegIntakeYear = `CAST(NULLIF(TRIM(COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.current_year')),
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.currentYear')),
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.academic_year')),
  JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningRegistrationExtras}, '$.academicYear')),
  ''
)), '') AS UNSIGNED)`;

  const sqlAdmissionSeriesYear = `CAST(NULLIF(LEFT(TRIM(${p}admission_number), 4), '') AS UNSIGNED)`;

  const sqlIsBtechCourseName = `(
  (
    LOWER(TRIM(COALESCE(${p}course, ''))) REGEXP 'b[.]?[[:space:]]*tech'
    OR REPLACE(LOWER(TRIM(COALESCE(${p}course, ''))), ' ', '') LIKE '%btech%'
  )
  AND LOWER(TRIM(COALESCE(${p}course, ''))) NOT REGEXP 'm[.]?[[:space:]]*tech'
)`;

  const sqlIsBtechLateralAdmission = `(
  ${sqlIsBtechCourseName}
  AND (
    LOWER(${sqlRegStudentStatus}) LIKE '%lateral%'
    OR ${sqlRegSemester} = '2-1'
    OR (
      ${sqlAdmissionSeriesYear} IS NOT NULL
      AND ${sqlRegIntakeYear} IS NOT NULL
      AND ${sqlRegIntakeYear} = ${sqlAdmissionSeriesYear} - 1
    )
    OR UPPER(TRIM(COALESCE(${p}quota, ''))) LIKE '%LATERAL%ENTRY%'
    OR UPPER(TRIM(COALESCE(${p}quota, ''))) = 'LATERAL ENTRY'
    OR LOWER(TRIM(COALESCE(${p}course, ''))) LIKE '%(lateral)%'
  )
)`;

  return `(CASE WHEN ${sqlIsBtechLateralAdmission} THEN 1 ELSE 0 END)`;
};

/** `lead_data._joiningRegistrationExtras` JSON for stats / list SQL (unqualified `admissions`). */
export const SQL_JOINING_REGISTRATION_EXTRAS = `COALESCE(
  CASE
    WHEN JSON_VALID(lead_data)
      AND JSON_TYPE(JSON_EXTRACT(lead_data, '$._joiningRegistrationExtras')) = 'OBJECT'
    THEN JSON_EXTRACT(lead_data, '$._joiningRegistrationExtras')
    ELSE JSON_OBJECT()
  END,
  JSON_OBJECT()
)`;

const SQL_REG_STUDENT_STATUS = `NULLIF(TRIM(COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.student_status')),
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.studentStatus')),
  ''
)), '')`;

const SQL_REG_SEMESTER = `NULLIF(TRIM(COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.semester')),
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.current_semester')),
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.currentSemester')),
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.semister')),
  ''
)), '')`;

const SQL_REG_INTAKE_YEAR = `CAST(NULLIF(TRIM(COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.current_year')),
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.currentYear')),
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.academic_year')),
  JSON_UNQUOTE(JSON_EXTRACT(${SQL_JOINING_REGISTRATION_EXTRAS}, '$.academicYear')),
  ''
)), '') AS UNSIGNED)`;

const SQL_ADMISSION_SERIES_YEAR = `CAST(NULLIF(LEFT(TRIM(admission_number), 4), '') AS UNSIGNED)`;

export const SQL_IS_BTECH_COURSE_NAME = `(
  (
    LOWER(TRIM(COALESCE(course, ''))) REGEXP 'b[.]?[[:space:]]*tech'
    OR REPLACE(LOWER(TRIM(COALESCE(course, ''))), ' ', '') LIKE '%btech%'
  )
  AND LOWER(TRIM(COALESCE(course, ''))) NOT REGEXP 'm[.]?[[:space:]]*tech'
)`;

/** Lateral B.Tech track — registration extras, quota, or stored course label. */
export const SQL_IS_BTECH_LATERAL_ADMISSION = `(
  ${SQL_IS_BTECH_COURSE_NAME}
  AND (
    LOWER(${SQL_REG_STUDENT_STATUS}) LIKE '%lateral%'
    OR ${SQL_REG_SEMESTER} = '2-1'
    OR (
      ${SQL_ADMISSION_SERIES_YEAR} IS NOT NULL
      AND ${SQL_REG_INTAKE_YEAR} IS NOT NULL
      AND ${SQL_REG_INTAKE_YEAR} = ${SQL_ADMISSION_SERIES_YEAR} - 1
    )
    OR UPPER(TRIM(COALESCE(quota, ''))) LIKE '%LATERAL%ENTRY%'
    OR UPPER(TRIM(COALESCE(quota, ''))) = 'LATERAL ENTRY'
    OR LOWER(TRIM(COALESCE(course, ''))) LIKE '%(lateral)%'
  )
)`;

export const SQL_BTECH_LATERAL_TRACK = buildSqlBtechLateralTrack('');
/** Lateral track on pivot queries (`FROM admissions a …`). */
export const SQL_A_BTECH_LATERAL_TRACK = buildSqlBtechLateralTrack('a');

/**
 * Course string for secondary `students.course` — catalog names only (no "(LATERAL)" suffix).
 */
export const normalizeCourseNameForSecondarySync = (courseName) => {
  let label = String(courseName ?? '').trim();
  if (!label) return '';
  label = label.replace(/\s*\(lateral\)\s*/gi, '').trim();
  if (/^degree$/i.test(label)) return 'B.Sc';
  if (/^b\.?\s*tech\s*le$/i.test(label)) return 'B.Tech';
  if (isBtechCourseName(label)) return label.replace(/\s*\(lateral\)\s*/gi, '').trim() || 'B.Tech';
  return label;
};

/** Semester token for student_data (e.g. 2-1 for B.Tech lateral only). */
export const resolveSecondarySemesterForSync = (
  registrationExtras,
  admissionNumber,
  courseLabel = ''
) => {
  const sem = String(
    registrationExtras?.semester ??
      registrationExtras?.current_semester ??
      registrationExtras?.currentSemester ??
      registrationExtras?.semister ??
      ''
  ).trim();
  if (sem === '1') return '1-1';
  if (sem) return sem;

  const baseCourse = normalizeCourseNameForSecondarySync(courseLabel);
  if (/^b\.?\s*sc$/i.test(baseCourse) || /^degree$/i.test(String(courseLabel || '').trim())) {
    return '1-1';
  }

  if (
    /^diploma$/i.test(baseCourse) &&
    !isLateralRegistrationExtras(registrationExtras, admissionNumber)
  ) {
    return '1-1';
  }

  if (
    isBtechCourseName(baseCourse) &&
    isLateralRegistrationExtras(registrationExtras, admissionNumber)
  ) {
    return '2-1';
  }
  return null;
};

export const SQL_COURSE_DISPLAY_NAME = `MAX(
  CASE
    WHEN ${SQL_IS_BTECH_LATERAL_ADMISSION} AND LOWER(TRIM(COALESCE(course, ''))) NOT LIKE '%(lateral)%'
      THEN CONCAT(TRIM(COALESCE(course, '')), ' (LATERAL)')
    ELSE TRIM(COALESCE(course, ''))
  END
)`;
