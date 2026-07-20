const PLACEHOLDER_ADDRESS_VALUES = new Set([
  'not provided',
  'not specified',
  'n/a',
  'na',
  'nil',
  'none',
  '-',
  '—',
]);

/** Treat CRM placeholder strings as empty for structured address fields. */
export const normalizeAddressFieldForStorage = (value) => {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (PLACEHOLDER_ADDRESS_VALUES.has(s.toLowerCase())) return '';
  return s;
};

export const normalizeCommunicationAddress = (communication = {}) => ({
  doorOrStreet: normalizeAddressFieldForStorage(communication.doorOrStreet),
  landmark: normalizeAddressFieldForStorage(communication.landmark),
  villageOrCity: normalizeAddressFieldForStorage(communication.villageOrCity),
  mandal: normalizeAddressFieldForStorage(communication.mandal),
  district: normalizeAddressFieldForStorage(communication.district),
  pinCode: normalizeAddressFieldForStorage(communication.pinCode),
  state: normalizeAddressFieldForStorage(communication.state),
});

export const communicationAddressHasValues = (communication = {}) =>
  Object.values(normalizeCommunicationAddress(communication)).some(Boolean);

function pickRegistrationAddressExtra(registrationFormData, keys) {
  const reg =
    registrationFormData && typeof registrationFormData === 'object' ? registrationFormData : {};
  const want = new Set(keys.map((k) => String(k).toLowerCase()));
  for (const [k, v] of Object.entries(reg)) {
    if (!want.has(String(k).toLowerCase())) continue;
    const s = normalizeAddressFieldForStorage(v);
    if (s) return s;
  }
  return '';
}

function sqlAddressField(row, column, registrationFormData, regKeys) {
  const fromSql = normalizeAddressFieldForStorage(row?.[column]);
  if (fromSql) return fromSql;
  return pickRegistrationAddressExtra(registrationFormData, regKeys);
}

/** Map SQL address columns (+ optional registration extras fallback) to API communication address. */
export const communicationAddressFromSqlRow = (row, registrationFormData = {}) => {
  return normalizeCommunicationAddress({
    doorOrStreet: sqlAddressField(row, 'address_door_street', registrationFormData, [
      'address_door_street',
      'door_street',
    ]),
    landmark: sqlAddressField(row, 'address_landmark', registrationFormData, [
      'address_landmark',
      'landmark',
    ]),
    villageOrCity: sqlAddressField(row, 'address_village_city', registrationFormData, [
      'address_village_city',
      'village',
      'city',
      'address_village',
    ]),
    mandal: sqlAddressField(row, 'address_mandal', registrationFormData, ['address_mandal', 'mandal']),
    district: sqlAddressField(row, 'address_district', registrationFormData, [
      'address_district',
      'district',
    ]),
    pinCode: sqlAddressField(row, 'address_pin_code', registrationFormData, [
      'pincode',
      'pin_code',
      'address_pin_code',
    ]),
    state: sqlAddressField(row, 'address_state', registrationFormData, ['state', 'address_state']),
  });
};

/** Map a joining_relatives / admission_relatives SQL row to API shape. */
export const relativeAddressFromSqlRow = (rel) => ({
  name: rel?.name || '',
  relationship: rel?.relationship || '',
  phone: rel?.phone || '',
  isGuardian: Boolean(rel?.is_guardian),
  state: normalizeAddressFieldForStorage(rel?.state),
  doorOrStreet: normalizeAddressFieldForStorage(rel?.door_street),
  landmark: normalizeAddressFieldForStorage(rel?.landmark),
  villageOrCity: normalizeAddressFieldForStorage(rel?.village_city),
  mandal: normalizeAddressFieldForStorage(rel?.mandal),
  district: normalizeAddressFieldForStorage(rel?.district),
  pinCode: normalizeAddressFieldForStorage(rel?.pin_code),
});
