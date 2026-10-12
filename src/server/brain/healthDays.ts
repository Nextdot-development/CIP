/**
 * Health awareness days, the external feed a hospital's calendar needs.
 *
 * The CIS briefing names it for the Social Media Calendar: "an occasions /
 * cultural-moments calendar". World days are observed everywhere (market
 * null); national days carry their country. Days that move from year to year
 * are written for the year they fall in.
 */
export type HealthDay = { occasion: string; startsOn: string; endsOn?: string; market: string | null };

export const HEALTH_DAYS: HealthDay[] = [
  // 2026, from October
  { occasion: 'Breast Cancer Awareness Month', startsOn: '2026-10-01', endsOn: '2026-10-31', market: null },
  { occasion: 'World Mental Health Day', startsOn: '2026-10-10', market: null },
  { occasion: 'World Polio Day', startsOn: '2026-10-24', market: null },
  { occasion: 'World Stroke Day', startsOn: '2026-10-29', market: null },
  { occasion: 'National Cancer Awareness Day', startsOn: '2026-11-07', market: 'India' },
  { occasion: 'World Pneumonia Day', startsOn: '2026-11-12', market: null },
  { occasion: 'World Diabetes Day', startsOn: '2026-11-14', market: null },
  { occasion: 'World Prematurity Day', startsOn: '2026-11-17', market: null },
  { occasion: 'World AIDS Day', startsOn: '2026-12-01', market: null },
  // 2027
  { occasion: 'World Cancer Day', startsOn: '2027-02-04', market: null },
  { occasion: 'International Childhood Cancer Day', startsOn: '2027-02-15', market: null },
  { occasion: 'World Kidney Day', startsOn: '2027-03-11', market: null },
  { occasion: 'World Oral Health Day', startsOn: '2027-03-20', market: null },
  { occasion: 'World TB Day', startsOn: '2027-03-24', market: null },
  { occasion: 'World Autism Awareness Day', startsOn: '2027-04-02', market: null },
  { occasion: 'World Health Day', startsOn: '2027-04-07', market: null },
  { occasion: 'World Haemophilia Day', startsOn: '2027-04-17', market: null },
  { occasion: 'World Liver Day', startsOn: '2027-04-19', market: null },
  { occasion: 'World Malaria Day', startsOn: '2027-04-25', market: null },
  { occasion: 'World Asthma Day', startsOn: '2027-05-04', market: null },
  { occasion: 'World Hand Hygiene Day', startsOn: '2027-05-05', market: null },
  { occasion: 'World Thalassaemia Day', startsOn: '2027-05-08', market: null },
  { occasion: 'International Nurses Day', startsOn: '2027-05-12', market: null },
  { occasion: 'World Hypertension Day', startsOn: '2027-05-17', market: null },
  { occasion: 'World No Tobacco Day', startsOn: '2027-05-31', market: null },
  { occasion: 'World Blood Donor Day', startsOn: '2027-06-14', market: null },
  { occasion: 'International Day of Yoga', startsOn: '2027-06-21', market: null },
  { occasion: "National Doctors' Day", startsOn: '2027-07-01', market: 'India' },
  { occasion: 'World Hepatitis Day', startsOn: '2027-07-28', market: null },
  { occasion: 'World Breastfeeding Week', startsOn: '2027-08-01', endsOn: '2027-08-07', market: null },
  { occasion: "World Alzheimer's Day", startsOn: '2027-09-21', market: null },
  { occasion: 'World Heart Day', startsOn: '2027-09-29', market: null },
  { occasion: 'Breast Cancer Awareness Month', startsOn: '2027-10-01', endsOn: '2027-10-31', market: null },
  { occasion: 'World Mental Health Day', startsOn: '2027-10-10', market: null },
  { occasion: 'World Sight Day', startsOn: '2027-10-14', market: null },
  { occasion: 'World Polio Day', startsOn: '2027-10-24', market: null },
  { occasion: 'World Stroke Day', startsOn: '2027-10-29', market: null },
  { occasion: 'National Cancer Awareness Day', startsOn: '2027-11-07', market: 'India' },
  { occasion: 'World Diabetes Day', startsOn: '2027-11-14', market: null },
  { occasion: 'World AIDS Day', startsOn: '2027-12-01', market: null },
];
