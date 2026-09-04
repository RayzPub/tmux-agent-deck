/**
 * Automatically calculates the next available session name with an auto-incrementing serial number.
 * Supports styles:
 * - Hyphenated: dev-1 -> dev-2, shell -> shell-2
 * - Underscore: dev_1 -> dev_2
 * - Direct digits: agy2 -> agy3, cctest -> cctest3 (when existing sessions follow unseparated numbers)
 * - Retains words like win11 or gpt4 as base (win11 -> win11-2) unless the word without digits is an existing base
 */
export function getNextAvailableSessionName(requestedName, existingNames = []) {
  if (!requestedName) requestedName = 'session';
  const nameSet = new Set(existingNames);
  if (!nameSet.has(requestedName)) {
    return requestedName;
  }

  const matchSep = requestedName.match(/^(.*?)([-_])(\d+)$/);
  const matchNoSep = requestedName.match(/^(.*?)(\d+)$/);

  let base = requestedName;
  let sep = '-';
  let startNum = 2;

  if (matchSep) {
    base = matchSep[1] || requestedName;
    sep = matchSep[2];
    startNum = parseInt(matchSep[3], 10) + 1;
  } else if (matchNoSep && nameSet.has(matchNoSep[1])) {
    base = matchNoSep[1];
    sep = '';
    startNum = parseInt(matchNoSep[2], 10) + 1;
  } else {
    base = requestedName;
    const hasUnseparated = existingNames.some(n => new RegExp(`^${base}\\d+$`).test(n));
    const hasUnderscore = existingNames.some(n => new RegExp(`^${base}_\\d+$`).test(n));
    if (hasUnseparated) {
      sep = '';
    } else if (hasUnderscore) {
      sep = '_';
    } else {
      sep = '-';
    }
    startNum = 2;
  }

  let num = startNum;
  while (nameSet.has(`${base}${sep}${num}`)) {
    num++;
  }
  return `${base}${sep}${num}`;
}
