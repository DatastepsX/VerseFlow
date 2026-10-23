import type { TimedWord } from "@/lib/audio/lyrics";

/**
 * Sounds sung to find the flow ("pom pom para pa pa pom", "na na", "yeah")
 * come back from the recognition as words. They aren't lyrics: they don't
 * give the topic, don't rhyme and mustn't be kept — the flow is na-na there.
 */

/** clearly not words: pom, pam, para, nanana, yeah, oh, mmm… */
const SOUND = /^(?:p[aou]m+|b[aou]m+|d[aou]m+|t[aou]m+|para|pa(?:pa)+|pi|po|pu|ba|bi|du|di|dun|tun|ta(?:ta)+|na(?:na)+|la(?:la)+|da(?:da)+|ra(?:ra)+|ye+a*h*|ye+|oh+|o+h|uh+|ah+|eh+|m+h*m*|hm+|wo+h?|uo+|yo+)$/;
/** also real words ("la", "da", "ta", "na", "pa"…): sounds only when the whole take is sounds */
const MAYBE = /^(?:la|da|ta|na|pa|ra|ma|no|di|mi|ti|tu)$/;
/** a short chunk repeated: "papapa", "nanana", "tatata" */
const REPEATED = /^([a-z]{1,3})\1{1,}$/;

const norm = (w: string) =>
  w
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z]/g, "");

export function isSound(word: string) {
  const w = norm(word);
  return !!w && (SOUND.test(w) || REPEATED.test(w));
}

/** the recognised words without the sung sounds (a take that is mostly sounds keeps no words at all) */
export function dropSounds(words: TimedWord[]): TimedWord[] {
  return splitSounds(words).words;
}

/** the recognised words (lyrics) and the sung sounds (only good for counting syllables) */
export function splitSounds(words: TimedWord[]): { words: TimedWord[]; sounds: TimedWord[] } {
  if (!words.length) return { words, sounds: [] };
  const n = words.filter((w) => isSound(w.text) || MAYBE.test(norm(w.text))).length;
  if (n / words.length >= 0.6) return { words: [], sounds: words };
  return { words: words.filter((w) => !isSound(w.text)), sounds: words.filter((w) => isSound(w.text)) };
}
