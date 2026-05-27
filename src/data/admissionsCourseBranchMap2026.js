/**
 * Canonical course/branch labels + secondary DB ids for 2026 admissions master list.
 * Excel "Diploma" and "Polytechnic" → Diploma. Branches align to secondary `course_branches`.
 */

export const mapCourseLabel = (course) => {
  const c = String(course ?? '').trim();
  if (!c) return c;
  if (/^polytechnic$/i.test(c)) return 'Diploma';
  if (/^diploma\s*technical$/i.test(c)) return 'Diploma';
  if (/^b\.?\s*tech\s*le$/i.test(c)) return 'B.Tech';
  if (/^degree$/i.test(c)) return 'B.Sc';
  if (/^b\.?\s*sc$/i.test(c)) return 'B.Sc';
  return c.replace(/\s*\(lateral\)\s*/gi, '').trim();
};

const STATIC_BRANCH = {
  'B Pharmacy': 'B.Pharm',
  'M Pharm PQA': 'Pharmaceutical Quality Assurance',
  'M Pharm Ceutics': 'Pharmaceutics',
  'M Tech CSE(AIML)': 'AIML',
  'CSE (AI)': 'CSE(AI)',
  'B Sc Agriculture': 'Agriculture & Rural Development',
  'B Sc Fisheries': 'Fisheries',
  Others: 'DAP',
  MBA: 'MBA',
  MCA: 'MCA',
};

/** @returns {{ course: string, branch: string }} */
export const mapCourseAndBranch = (course, branch) => {
  const mappedCourse = mapCourseLabel(course);
  let b = String(branch ?? '').trim();
  if (STATIC_BRANCH[b]) b = STATIC_BRANCH[b];

  if (mappedCourse === 'Diploma') {
    if (/^ECE$/i.test(b)) b = 'DECE';
    else if (/^CSE$/i.test(b)) b = 'DCSE';
    else if (/^DMECH$/i.test(b)) b = 'DMEC';
    else if (/^DCME$/i.test(b)) b = 'DMEC';
    else if (/DCSE.*AIML/i.test(b)) b = 'DCSE(AIML)';
  }

  if (mappedCourse === 'Degree' && /^Others$/i.test(b)) {
    return { course: 'DAP-PTV', branch: 'DAP' };
  }
  if (/^degree\s*pvrt$/i.test(mappedCourse)) {
    return { course: 'DAP-PTV', branch: b === 'DAP' ? 'DAP' : b };
  }

  return { course: mappedCourse, branch: b };
};

/**
 * Secondary DB course_id / branch_id (from live catalog).
 * Keys: `${course}|${branch}` (uppercase).
 */
export const SECONDARY_COURSE_BRANCH_IDS = {
  'B.PHARM|B.PHARM': { courseId: '3', branchId: '44' },
  'B.TECH|CSE(AI)': { courseId: '1', branchId: '42' },
  'B.TECH|ECE': { courseId: '1', branchId: '40' },
  'DIPLOMA|DCSE': { courseId: '2', branchId: '50' },
  'DIPLOMA|DCSE(AIML)': { courseId: '2', branchId: '214' },
  'DIPLOMA|DECE': { courseId: '2', branchId: '52' },
  'DIPLOMA|DMEC': { courseId: '2', branchId: '53' },
  'DEGREE|AGRICULTURE & RURAL DEVELOPMENT': { courseId: '4', branchId: '46' },
  'DEGREE|FISHERIES': { courseId: '4', branchId: '47' },
  'B.SC|AGRICULTURE & RURAL DEVELOPMENT': { courseId: '4', branchId: '46' },
  'B.SC|FISHERIES': { courseId: '4', branchId: '47' },
  'DAP-PTV|DAP': { courseId: '17', branchId: '198' },
  'DEGREE PVRT|DAP': { courseId: '17', branchId: '198' },
  'M.PHARM|PHARMACEUTICAL QUALITY ASSURANCE': { courseId: '10', branchId: '64' },
  'M.PHARM|PHARMACEUTICS': { courseId: '10', branchId: '62' },
  'M.TECH|AIML': { courseId: '6', branchId: '67' },
  'MBA|MBA': { courseId: '7', branchId: '60' },
  'MCA|MCA': { courseId: '8', branchId: '61' },
};

export const resolveSecondaryManagedIds = (course, branch) => {
  const { course: c, branch: b } = mapCourseAndBranch(course, branch);
  const key = `${c}|${b}`.toUpperCase();
  const hit =
    SECONDARY_COURSE_BRANCH_IDS[key] ||
    Object.entries(SECONDARY_COURSE_BRANCH_IDS).find(([k]) => {
      const [kc, kb] = k.split('|');
      return kc === c.toUpperCase() && kb === b.toUpperCase();
    })?.[1];
  return hit ? { managedCourseId: hit.courseId, managedBranchId: hit.branchId, course: c, branch: b } : { managedCourseId: null, managedBranchId: null, course: c, branch: b };
};
