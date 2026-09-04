// Seed Data Store for Emergency Resource Allocation System

export const initialHospitals = [
  {
    id: "H-101",
    name: "Apex City Trauma & Super Specialty Center",
    address: "Central Medical District, Ave 4",
    status: "OPEN", // OPEN, LIMITED, CLOSED
    distanceKm: 4.2,
    acceptanceRate: 0.94, // 94% historical acceptance
    avgResponseSec: 32,
    rating: 4.8,
    resources: {
      icuBeds: { total: 20, available: 4, locked: 0 },
      ventilators: { total: 15, available: 3, locked: 0 },
      emergencyOT: { total: 6, available: 2, locked: 0 },
      specialists: {
        cardiologist: true,
        neurologist: true,
        traumaSurgeon: true,
        pediatrician: true
      }
    }
  },
  {
    id: "H-102",
    name: "St. Jude Metro General Hospital",
    address: "North Sector 12, Parkway",
    status: "LIMITED",
    distanceKm: 2.1,
    acceptanceRate: 0.78,
    avgResponseSec: 54,
    rating: 4.3,
    resources: {
      icuBeds: { total: 12, available: 1, locked: 0 },
      ventilators: { total: 8, available: 1, locked: 0 },
      emergencyOT: { total: 3, available: 0, locked: 0 },
      specialists: {
        cardiologist: false,
        neurologist: false,
        traumaSurgeon: true,
        pediatrician: false
      }
    }
  },
  {
    id: "H-103",
    name: "Fortis Cardiac & Neuro Institute",
    address: "South Expressway, Sector 8",
    status: "OPEN",
    distanceKm: 5.8,
    acceptanceRate: 0.96,
    avgResponseSec: 28,
    rating: 4.9,
    resources: {
      icuBeds: { total: 25, available: 8, locked: 0 },
      ventilators: { total: 18, available: 6, locked: 0 },
      emergencyOT: { total: 8, available: 4, locked: 0 },
      specialists: {
        cardiologist: true,
        neurologist: true,
        traumaSurgeon: true,
        pediatrician: true
      }
    }
  },
  {
    id: "H-104",
    name: "Memorial Community Healthcare Center",
    address: "East Ring Road, Block C",
    status: "OPEN",
    distanceKm: 1.8, // Nearest hospital!
    acceptanceRate: 0.72,
    avgResponseSec: 68,
    rating: 3.9,
    resources: {
      icuBeds: { total: 6, available: 0, locked: 0 }, // No ICU beds!
      ventilators: { total: 3, available: 0, locked: 0 },
      emergencyOT: { total: 1, available: 1, locked: 0 },
      specialists: {
        cardiologist: false,
        neurologist: false,
        traumaSurgeon: false,
        pediatrician: true
      }
    }
  },
  {
    id: "H-105",
    name: "Max Life Emergency & Research Center",
    address: "West Hub, Technology Corridor",
    status: "OPEN",
    distanceKm: 7.3,
    acceptanceRate: 0.91,
    avgResponseSec: 38,
    rating: 4.7,
    resources: {
      icuBeds: { total: 18, available: 5, locked: 0 },
      ventilators: { total: 12, available: 4, locked: 0 },
      emergencyOT: { total: 5, available: 3, locked: 0 },
      specialists: {
        cardiologist: true,
        neurologist: true,
        traumaSurgeon: true,
        pediatrician: false
      }
    }
  },
  {
    id: "H-106",
    name: "Downtown Care Hospital",
    address: "Old Town, Crossway 3",
    status: "CLOSED", // Divert / Diverting
    distanceKm: 3.5,
    acceptanceRate: 0.50,
    avgResponseSec: 95,
    rating: 3.4,
    resources: {
      icuBeds: { total: 8, available: 0, locked: 0 },
      ventilators: { total: 4, available: 0, locked: 0 },
      emergencyOT: { total: 2, available: 0, locked: 0 },
      specialists: {
        cardiologist: false,
        neurologist: false,
        traumaSurgeon: false,
        pediatrician: false
      }
    }
  }
];

export const initialAmbulances = [
  { id: "AMB-01", type: "ALS (Advanced Life Support)", status: "AVAILABLE", hospitalId: "H-101", etaMins: 4 },
  { id: "AMB-02", type: "ALS (Advanced Life Support)", status: "IN_TRANSIT", hospitalId: "H-103", etaMins: 9 },
  { id: "AMB-03", type: "BLS (Basic Life Support)", status: "AVAILABLE", hospitalId: "H-102", etaMins: 3 },
  { id: "AMB-04", type: "ALS (Advanced Life Support)", status: "AVAILABLE", hospitalId: "H-105", etaMins: 6 },
  { id: "AMB-05", type: "BLS (Basic Life Support)", status: "MAINTENANCE", hospitalId: "H-104", etaMins: 0 }
];

export const initialEmergencyQueue = [
  {
    requestId: "REQ-8901",
    patientName: "Robert Vance",
    age: 58,
    emergencyType: "CARDIAC",
    priority: 1,
    priorityName: "Level 1: Resuscitation",
    status: "ALLOCATED",
    assignedHospital: "Apex City Trauma",
    requestTime: "22:15:30",
    requiredResources: ["ICU Bed", "Ventilator", "Cardiologist"]
  },
  {
    requestId: "REQ-8902",
    patientName: "Sarah Jenkins",
    age: 34,
    emergencyType: "TRAUMA",
    priority: 2,
    priorityName: "Level 2: Emergent",
    status: "IN_TREATMENT",
    assignedHospital: "Fortis Cardiac & Neuro",
    requestTime: "22:04:12",
    requiredResources: ["Emergency OT", "Trauma Surgeon"]
  },
  {
    requestId: "REQ-8903",
    patientName: "David Miller",
    age: 45,
    emergencyType: "RESPIRATORY",
    priority: 3,
    priorityName: "Level 3: Urgent",
    status: "WAITING",
    assignedHospital: "Matching...",
    requestTime: "22:28:45",
    requiredResources: ["Ventilator"]
  }
];
