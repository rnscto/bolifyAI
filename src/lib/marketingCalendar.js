// Comprehensive marketing calendar with Indian & International occasions
// Month is 1-indexed (1=Jan, 12=Dec)
const OCCASIONS = [
  // January
  { id: 'new_year', name: 'New Year', date: '01-01', type: 'international', emoji: '🎉' },
  { id: 'lohri', name: 'Lohri', date: '01-13', type: 'indian_festival', emoji: '🔥' },
  { id: 'makar_sankranti', name: 'Makar Sankranti / Pongal', date: '01-14', type: 'indian_festival', emoji: '🪁' },
  { id: 'republic_day', name: 'Republic Day', date: '01-26', type: 'national', emoji: '🇮🇳' },

  // February
  { id: 'world_cancer_day', name: 'World Cancer Day', date: '02-04', type: 'awareness', emoji: '🎗️' },
  { id: 'valentines_day', name: "Valentine's Day", date: '02-14', type: 'international', emoji: '❤️' },
  { id: 'basant_panchami', name: 'Basant Panchami', date: '02-02', type: 'indian_festival', emoji: '🌼' },

  // March
  { id: 'womens_day', name: "International Women's Day", date: '03-08', type: 'international', emoji: '👩' },
  { id: 'holi', name: 'Holi', date: '03-14', type: 'indian_festival', emoji: '🎨' },
  { id: 'world_water_day', name: 'World Water Day', date: '03-22', type: 'awareness', emoji: '💧' },

  // April
  { id: 'fools_day', name: "April Fool's Day", date: '04-01', type: 'international', emoji: '🤡' },
  { id: 'ram_navami', name: 'Ram Navami', date: '04-06', type: 'indian_festival', emoji: '🏹' },
  { id: 'ambedkar_jayanti', name: 'Ambedkar Jayanti', date: '04-14', type: 'national', emoji: '📘' },
  { id: 'baisakhi', name: 'Baisakhi', date: '04-13', type: 'indian_festival', emoji: '🌾' },
  { id: 'earth_day', name: 'Earth Day', date: '04-22', type: 'awareness', emoji: '🌍' },
  { id: 'eid_ul_fitr', name: 'Eid ul-Fitr', date: '04-01', type: 'indian_festival', emoji: '🌙' },

  // May
  { id: 'labour_day', name: 'International Labour Day', date: '05-01', type: 'international', emoji: '⚒️' },
  { id: 'mothers_day', name: "Mother's Day", date: '05-11', type: 'international', emoji: '💐' },
  { id: 'buddha_purnima', name: 'Buddha Purnima', date: '05-12', type: 'indian_festival', emoji: '☸️' },

  // June
  { id: 'world_env_day', name: 'World Environment Day', date: '06-05', type: 'awareness', emoji: '🌱' },
  { id: 'fathers_day', name: "Father's Day", date: '06-15', type: 'international', emoji: '👨' },
  { id: 'yoga_day', name: 'International Yoga Day', date: '06-21', type: 'international', emoji: '🧘' },
  { id: 'eid_ul_adha', name: 'Eid ul-Adha (Bakra Eid)', date: '06-07', type: 'indian_festival', emoji: '🕌' },

  // July
  { id: 'doctors_day', name: "Doctor's Day (India)", date: '07-01', type: 'national', emoji: '👨‍⚕️' },
  { id: 'guru_purnima', name: 'Guru Purnima', date: '07-10', type: 'indian_festival', emoji: '🙏' },
  { id: 'muharram', name: 'Muharram', date: '07-07', type: 'indian_festival', emoji: '🕌' },

  // August
  { id: 'friendship_day', name: 'Friendship Day', date: '08-03', type: 'international', emoji: '🤝' },
  { id: 'independence_day', name: 'Independence Day', date: '08-15', type: 'national', emoji: '🇮🇳' },
  { id: 'rakshabandhan', name: 'Raksha Bandhan', date: '08-09', type: 'indian_festival', emoji: '🧵' },
  { id: 'janmashtami', name: 'Janmashtami', date: '08-16', type: 'indian_festival', emoji: '🦚' },

  // September
  { id: 'teachers_day', name: "Teacher's Day", date: '09-05', type: 'national', emoji: '📚' },
  { id: 'onam', name: 'Onam', date: '09-05', type: 'indian_festival', emoji: '🛶' },
  { id: 'ganesh_chaturthi', name: 'Ganesh Chaturthi', date: '09-07', type: 'indian_festival', emoji: '🐘' },
  { id: 'milad_un_nabi', name: 'Milad-un-Nabi', date: '09-05', type: 'indian_festival', emoji: '🌙' },

  // October
  { id: 'gandhi_jayanti', name: 'Gandhi Jayanti', date: '10-02', type: 'national', emoji: '🕊️' },
  { id: 'navratri', name: 'Navratri Begins', date: '10-02', type: 'indian_festival', emoji: '🪔' },
  { id: 'dussehra', name: 'Dussehra / Vijayadashami', date: '10-12', type: 'indian_festival', emoji: '🏹' },
  { id: 'karva_chauth', name: 'Karva Chauth', date: '10-17', type: 'indian_festival', emoji: '🌕' },
  { id: 'world_mental_health', name: 'World Mental Health Day', date: '10-10', type: 'awareness', emoji: '🧠' },
  { id: 'halloween', name: 'Halloween', date: '10-31', type: 'international', emoji: '🎃' },

  // November
  { id: 'diwali', name: 'Diwali', date: '11-01', type: 'indian_festival', emoji: '🪔' },
  { id: 'bhai_dooj', name: 'Bhai Dooj', date: '11-03', type: 'indian_festival', emoji: '👫' },
  { id: 'childrens_day', name: "Children's Day", date: '11-14', type: 'national', emoji: '👧' },
  { id: 'guru_nanak_jayanti', name: 'Guru Nanak Jayanti', date: '11-15', type: 'indian_festival', emoji: '🙏' },
  { id: 'thanksgiving', name: 'Thanksgiving', date: '11-27', type: 'international', emoji: '🦃' },
  { id: 'black_friday', name: 'Black Friday', date: '11-28', type: 'shopping', emoji: '🛒' },
  { id: 'cyber_monday', name: 'Cyber Monday', date: '11-30', type: 'shopping', emoji: '💻' },

  // December
  { id: 'world_aids_day', name: 'World AIDS Day', date: '12-01', type: 'awareness', emoji: '🎗️' },
  { id: 'christmas', name: 'Christmas', date: '12-25', type: 'international', emoji: '🎄' },
  { id: 'new_year_eve', name: "New Year's Eve", date: '12-31', type: 'international', emoji: '🎊' },
];

export const OCCASION_TYPES = {
  indian_festival: { label: 'Indian Festival', color: 'bg-orange-100 text-orange-800 border-orange-200' },
  national: { label: 'National Day', color: 'bg-green-100 text-green-800 border-green-200' },
  international: { label: 'International', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  awareness: { label: 'Awareness Day', color: 'bg-purple-100 text-purple-800 border-purple-200' },
  shopping: { label: 'Shopping Event', color: 'bg-pink-100 text-pink-800 border-pink-200' },
};

export function getOccasions() {
  return OCCASIONS;
}

export function getOccasionsForMonth(month) {
  const mm = String(month).padStart(2, '0');
  return OCCASIONS.filter(o => o.date.startsWith(mm + '-'));
}

export function getOccasionsForDate(dateStr, customOccasions = []) {
  // dateStr like "2026-03-08" → match "03-08"
  const mmdd = dateStr.substring(5);
  const all = [...OCCASIONS, ...customOccasions];
  return all.filter(o => o.date === mmdd);
}

export function getUpcomingOccasions(count = 10) {
  const today = new Date();
  const year = today.getFullYear();
  const todayStr = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  
  const upcoming = OCCASIONS
    .map(o => ({
      ...o,
      fullDate: `${year}-${o.date}`,
      isPast: o.date < todayStr
    }))
    .sort((a, b) => {
      const aDate = a.isPast ? `${year + 1}-${a.date}` : a.fullDate;
      const bDate = b.isPast ? `${year + 1}-${b.date}` : b.fullDate;
      return aDate.localeCompare(bDate);
    });
  
  return upcoming.slice(0, count);
}