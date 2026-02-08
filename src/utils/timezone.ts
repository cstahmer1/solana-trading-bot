export function getCSTDate(): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

export function getCSTMidnightToday(): Date {
  // Get today's date components in Chicago timezone using formatToParts
  const cst = getCSTDate();
  
  // Create a reference date at midnight local Chicago time conceptually
  // We need to find: what UTC timestamp corresponds to 00:00:00 on cst.year/cst.month/cst.day in America/Chicago?
  
  // Step 1: Create a UTC date for noon on the target Chicago date
  // Using noon avoids DST transition edge cases that happen at 2 AM
  const noonUtc = Date.UTC(cst.year, cst.month - 1, cst.day, 12, 0, 0, 0);
  const noonDate = new Date(noonUtc);
  
  // Step 2: Format this UTC noon time as if in Chicago to find the Chicago hour at UTC noon
  const chicagoFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  });
  const chicagoHourAtNoon = parseInt(chicagoFormatter.format(noonDate), 10);
  
  // Step 3: Calculate the offset in hours (Chicago is behind UTC)
  // If UTC noon shows as 6 AM in Chicago, offset is +6 hours (Chicago is UTC-6)
  // If UTC noon shows as 7 AM in Chicago, offset is +5 hours (Chicago is UTC-5, DST)
  const offsetHours = 12 - chicagoHourAtNoon;
  
  // Step 4: Chicago midnight = Date.UTC(year, month-1, day, offsetHours, 0, 0, 0)
  // Because midnight in Chicago (00:00) + offset hours = UTC time
  const midnightUtc = Date.UTC(cst.year, cst.month - 1, cst.day, offsetHours, 0, 0, 0);
  
  return new Date(midnightUtc);
}

export function getNextCSTMidnight(): Date {
  const cst = getCSTDate();
  const secondsIntoToday = cst.hour * 3600 + cst.minute * 60 + cst.second;
  const secondsUntilMidnight = 24 * 3600 - secondsIntoToday;
  const now = new Date();
  return new Date(now.getTime() + secondsUntilMidnight * 1000);
}

export function getNextCSTMidnightInfo(): { nextResetMs: number; secondsRemaining: number; dayStartedAt: number } {
  const now = Date.now();
  
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  
  const parts = formatter.formatToParts(new Date(now));
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') === 24 ? 0 : get('hour');
  const minute = get('minute');
  const second = get('second');
  
  const secondsIntoToday = hour * 3600 + minute * 60 + second;
  let secondsUntilMidnight = 86400 - secondsIntoToday;
  
  if (secondsUntilMidnight <= 0) {
    secondsUntilMidnight = 86400;
  }
  if (secondsUntilMidnight > 86400) {
    secondsUntilMidnight = 86400;
  }
  
  const nextResetMs = now + secondsUntilMidnight * 1000;
  const dayStartedAt = now - secondsIntoToday * 1000;
  
  return {
    nextResetMs,
    secondsRemaining: Math.max(0, Math.floor(secondsUntilMidnight)),
    dayStartedAt,
  };
}

export function todayKeyCST(): string {
  const cst = getCSTDate();
  return `${cst.year}-${String(cst.month).padStart(2, '0')}-${String(cst.day).padStart(2, '0')}`;
}
