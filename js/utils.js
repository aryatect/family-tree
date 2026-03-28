export function generateId() {
  return 'id-' + crypto.randomUUID();
}

export function formatDates(member) {
  const birth = member.birthday ? formatYear(member.birthday) : '?';
  const death = member.deathday ? formatYear(member.deathday) : null;
  if (death) return `${birth} – ${death}`;
  if (member.birthday) return `b. ${birth}`;
  return '';
}

function formatYear(dateStr) {
  if (!dateStr) return '';
  return dateStr.length === 4 ? dateStr : dateStr.substring(0, 4);
}

export function formatFullDate(dateStr) {
  if (!dateStr) return '';
  if (dateStr.length === 4) return dateStr;
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

export function getInitials(member) {
  const f = member.firstName ? member.firstName[0] : '';
  const l = member.lastName ? member.lastName[0] : '';
  return (f + l).toUpperCase() || '?';
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
