import { isWeakWord, prosody } from "@/lib/rhyme/prosody";

/**
 * Example words for a flow: a line of real words with exactly the tapped
 * number of syllables, its stressed words on the stressed taps — to see (and
 * hear) how long a bar is before writing it. Free: a small word bank, no AI.
 *
 * Every word starts with a consonant, so syllables never merge across words
 * (no synalepha) and the count is exact.
 */

const BANK: Record<string, string> = {
  it: "tu più già blu tre sì re me te notte cuore strada sole mare vento luce tempo fuoco casa sera nome passo piano sogno vita luna cielo pioggia mano voce cammino domani parole lontano momento destino ricordo bambino tramonto respiro paura città perché però sarà verità libertà nessuno sorriso felice sempre mai musica lacrima la di che per con ma se ti mi da lo ci ne mia tua",
  en: "night heart road rain love home time light fire dream sky stars cold gold river shadow broken never golden morning silver summer city running heaven ocean tonight alone away believe again return forget hello remember tomorrow together forever yesterday beautiful memory everything wonderful mystery the a to and my in of your we you",
  es: "sol mar luz ya fe voz mal noche luna calle tiempo fuego camino corazón mañana siempre nunca lejos vida beso cielo canción ciudad verdad libertad perdido recuerdo la de que por con mi tu se me te",
  de: "Nacht Herz Zeit Licht Traum Weg Wind Haus Mond Stadt Liebe Straße immer wieder heute Sonne Feuer Regen Himmel zusammen vergessen allein Gefühl die der das und mit dein mein zu im",
};

const words = new Map<string, { w: string; n: number; s: number }[]>();

function bank(lang: string) {
  const key = BANK[lang] ? lang : "it";
  if (!words.has(key)) {
    words.set(
      key,
      BANK[key]
        .split(" ")
        .map((w) => {
          const p = prosody(w, key);
          // s: the stressed syllable (0-based), -1 = an unstressed little word
          // a lone word always "ends a line" for prosody, so little words are recognised by name
          return { w, n: p.syllables, s: p.syllables === 1 && isWeakWord(w, key) ? -1 : (p.stresses[p.stresses.length - 1] ?? 0) };
        })
        .filter((x) => x.n >= 1 && x.n <= 4),
    );
  }
  return { key, list: words.get(key)! };
}

/**
 * n syllables, stresses at the given positions (1-based). seed varies the
 * words (the same flow can show other examples).
 */
export function exampleWords(n: number, stress: number[], lang: string, seed = 0): string {
  if (n < 1) return "";
  const { key, list } = bank(lang);
  const want = new Set(stress.map((s) => s - 1));
  // dp[i]: cheapest way to fill syllables 0..i-1; cost = stresses missed or misplaced
  const dp: { cost: number; prev: number; w: string }[] = [{ cost: 0, prev: -1, w: "" }];
  for (let i = 1; i <= n; i++) dp[i] = { cost: Infinity, prev: -1, w: "" };
  for (let i = 0; i < n; i++) {
    if (dp[i].cost === Infinity) continue;
    list.forEach((x, k) => {
      const j = i + x.n;
      if (j > n) return;
      let cost = 0;
      for (let p = i; p < j; p++) {
        const stressedHere = x.s >= 0 && p === i + x.s;
        if (want.has(p) !== stressedHere) cost += want.has(p) ? 1 : 0.4;
      }
      // little words only to fill gaps (a line of "my to and the" says nothing)
      if (x.s < 0) cost += 0.55;
      // the line ends on a real word, not on "con", "of"…
      if (j === n && x.s < 0) cost += 3;
      // variety: a pseudo-random tie-break per seed, and a small preference for longer words
      cost += (((k * 7919 + seed * 104729 + i * 31) % 97) / 97) * 0.3 - x.n * 0.05;
      if (dp[i].cost + cost < dp[j].cost) dp[j] = { cost: dp[i].cost + cost, prev: i, w: x.w };
    });
  }
  const out: string[] = [];
  for (let i = n; i > 0 && dp[i].prev >= 0; i = dp[i].prev) out.unshift(dp[i].w);
  // no word twice: a repeat becomes another word of the same shape (syllables + stress)
  const used = new Set<string>();
  const varied = out.map((w, i) => {
    if (!used.has(w)) return used.add(w), w;
    const shape = list.find((x) => x.w === w)!;
    const same = list.filter((x) => x.n === shape.n && x.s === shape.s && !used.has(x.w));
    const twins = same.length ? same : list.filter((x) => x.n === shape.n && x.s >= 0 && !used.has(x.w));
    const pick = twins.length ? twins[(seed + i * 13) % twins.length].w : w;
    used.add(pick);
    return pick;
  });
  const line = varied.join(" ");
  return key === "de" ? line : line.charAt(0).toUpperCase() + line.slice(1);
}
