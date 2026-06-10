/** Map SQL address columns (+ optional registration extras fallback) to API communication address. */
export const communicationAddressFromSqlRow = (row, registrationFormData = {}) => {
  const reg =
    registrationFormData && typeof registrationFormData === 'object' ? registrationFormData : {};
  const regState = String(reg.address_state || reg.state || '').trim();
  return {
    state: String(row?.address_state || '').trim() || regState,
    doorOrStreet: row?.address_door_street || '',
    landmark: row?.address_landmark || '',
    villageOrCity: row?.address_village_city || '',
    mandal: row?.address_mandal || '',
    district: row?.address_district || '',
    pinCode: row?.address_pin_code || '',
  };
};

/** Map a joining_relatives / admission_relatives SQL row to API shape. */
export const relativeAddressFromSqlRow = (rel) => ({
  name: rel?.name || '',
  relationship: rel?.relationship || '',
  phone: rel?.phone || '',
  state: rel?.state || '',
  doorOrStreet: rel?.door_street || '',
  landmark: rel?.landmark || '',
  villageOrCity: rel?.village_city || '',
  mandal: rel?.mandal || '',
  district: rel?.district || '',
  pinCode: rel?.pin_code || '',
});
