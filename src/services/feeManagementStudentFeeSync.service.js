const trimTrailingSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

export const syncStudentFeesToFeeManagement = async (admissionNumber, options = {}) => {
  const safeAdmissionNumber = String(admissionNumber || '').trim();
  if (!safeAdmissionNumber) {
    return { skipped: true, reason: 'missing admission number' };
  }

  const baseUrl = trimTrailingSlash(process.env.FEE_MANAGEMENT_API_URL);
  const secret = String(process.env.STUDENT_FEE_SYNC_SECRET || '').trim();
  if (!baseUrl || !secret) {
    if (!options.silent) {
      console.warn(
        '[fee-management-sync] skipped: FEE_MANAGEMENT_API_URL or STUDENT_FEE_SYNC_SECRET not set'
      );
    }
    return { skipped: true, reason: 'missing fee management sync env' };
  }

  try {
    const response = await fetch(`${baseUrl}/api/sync/student-fees`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Student-Sync-Secret': secret,
      },
      body: JSON.stringify({ admissionNumber: safeAdmissionNumber }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 207) {
      throw new Error(data?.message || `Fee sync failed (${response.status})`);
    }
    return {
      ok: response.ok,
      partial: response.status === 207,
      status: response.status,
      data,
    };
  } catch (error) {
    console.warn(
      `[fee-management-sync] student fee sync failed for ${safeAdmissionNumber}:`,
      error?.message || error
    );
    return { ok: false, error: error?.message || String(error) };
  }
};
