// Shared, explicit test fixture for the contract suite. Every name and number is fictional and exists
// only for these tests (it is not the demo seed). Hospitals start with ZERO capacity: each test grants
// exactly the capacity it needs with backend.setCapacity(), so no hidden seed state affects a result.

export const HOSPITALS = [
  { hospital_id: 'H-A', hospital_name: 'Contract Hospital A', emergency_status: 'OPEN', acceptance_rate: 0.95, avg_response_sec: 30 },
  { hospital_id: 'H-B', hospital_name: 'Contract Hospital B', emergency_status: 'OPEN', acceptance_rate: 0.85, avg_response_sec: 40 },
  { hospital_id: 'H-C', hospital_name: 'Contract Hospital C', emergency_status: 'CLOSED', acceptance_rate: 0.70, avg_response_sec: 50 },
  { hospital_id: 'H-D', hospital_name: 'Contract Hospital D', emergency_status: 'OPEN', acceptance_rate: 0.60, avg_response_sec: 60 }
];

export const RESOURCE_TYPES = ['ICU_BED', 'OT', 'VENTILATOR'];

export const RESOURCES = HOSPITALS.flatMap(h => RESOURCE_TYPES.map(type => ({
  resource_id: `RES-${h.hospital_id}-${type}`,
  hospital_id: h.hospital_id,
  resource_type: type,
  total_capacity: 0,
  available_capacity: 0,
  locked_capacity: 0
})));

export const DOCTORS = [
  { doctor_id: 'DR-A01', hospital_id: 'H-A', full_name: 'Fictional Cardiologist A', specialization: 'CARDIOLOGIST', availability_status: 'AVAILABLE' }
];

export const AMBULANCES = [
  { ambulance_id: 'AMB-A1', hospital_id: 'H-A', vehicle_number: 'FIC-A1', ambulance_type: 'ALS', status: 'AVAILABLE' },
  { ambulance_id: 'AMB-B1', hospital_id: 'H-B', vehicle_number: 'FIC-B1', ambulance_type: 'BLS', status: 'AVAILABLE' }
];

export const COORDINATES = { location_lat: 28.6, location_lng: 77.2 };
