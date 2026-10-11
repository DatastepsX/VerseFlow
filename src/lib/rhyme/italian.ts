/**
 * Italian phonology for songwriting: syllables, stress and rhyme keys.
 *
 * Words are converted to a simplified phoneme string (one char per sound) so
 * that spelling differences don't break rhymes ("cuore" / "amore" → "ore",
 * "ghiaccio" / "spacco" share the vowels "a-o"). Stress follows Italian
 * defaults: written accent wins, otherwise the penultimate syllable (parola
 * piana), with a list of common proparoxytones (parole sdrucciole).
 */

import type { WordPhonology } from "./types";

const VOWELS = "aeiou";
const ACCENTED: Record<string, string> = {
  à: "a", á: "a", â: "a",
  è: "e", é: "e", ê: "e",
  ì: "i", í: "i", î: "i",
  ò: "o", ó: "o", ô: "o",
  ù: "u", ú: "u", û: "u",
};

// Common parole sdrucciole (stress on the antepenultimate syllable).
const SDRUCCIOLE = new Set(
  (
    "anima anime lacrima lacrime ultimo ultima ultimi ultime subito attimo attimi musica musiche " +
    "unico unica unici uniche magico magica magici fragile fragili facile facili difficile difficili " +
    "pagina pagine giovane giovani limite limiti numero numeri angelo angeli polvere cenere tavolo " +
    "secolo secoli popolo piccolo piccola piccoli piccole rapido rapida timido timida libero libera " +
    "liberi libere lucido lucida umido vivido stupido stupida stupidi credere vivere perdere scrivere " +
    "chiedere leggere prendere vendere ridere piangere correre nascere crescere scegliere togliere " +
    "cogliere mettere battere essere muovere rispondere nascondere scendere spendere spegnere " +
    "chiudere uccidere decidere dividere ripetere promettere permettere smettere accendere " +
    "difendere offendere pretendere sorridere rompere vincere spingere fingere dipingere stringere " +
    "piangere giungere aggiungere raggiungere tingere torcere cuocere nuocere mungere ungere " +
    "camera camere medico medici logico logica logici tipico tipica pratico pratica comico comica " +
    "tragico tragica classico classica cinico cinica critico critica politico politica " +
    "fisico fisica chimica storico storica simbolo simboli diavolo diavoli lettera lettere " +
    "opera opere epoca epoche favola favole regola regole tavola tavole isola isole " +
    "ottimo ottima pessimo pessima massimo massima minimo minima prossimo prossima " +
    "albero alberi zucchero fulmine fulmini margine margini ordine ordini origine immagine immagini " +
    "vertigine vertigini abitudine abitudini solitudine gratitudine moltitudine " +
    "aquila aquile rondine rondini lampada lampade nuvola nuvole briciola briciole " +
    "vittima vittime mandorla fiaccola"
  )
    .split(/\s+/)
    .filter(Boolean),
);

// Suffixes that reliably mark a parola sdrucciola.
const SDRUCCIOLA_SUFFIX =
  /(abile|abili|ibile|ibili|evole|evoli|issimo|issima|issimi|issime|arono|erono|irono|avano|evano|ivano|ebbero|essero|assero|issero|ossero|ussero|iscono|uscono|gine|gini|udine|udini|ologo|ologa|ologi|ofono|ografo|ografa|esimo|esima|esimi)$/;

// Monosyllables / truncated words that carry final stress even without accent.
const OXYTONE_WORDS = new Set(
  "piu pero perche poiche cosi gia la li si no blu tv cioe ne sta va fa da do su gru tre re me te se".split(" "),
);

/**
 * Common parole tronche, with accents. Lets unaccented input ("citta",
 * "perche") be stressed correctly and feeds the rhyme dictionary, whose word
 * list lost its accents.
 */
export const COMMON_OXYTONES = (
  "città verità libertà età novità felicità realtà società volontà bontà umanità eternità identità " +
  "difficoltà possibilità necessità tranquillità capacità qualità quantità pietà metà onestà falsità " +
  "oscurità sincerità fedeltà crudeltà vanità attività università comunità sarà farà avrà potrà dovrà " +
  "vorrà andrà verrà starà dirà darà saprà vedrà là già qua più giù virtù gioventù schiavitù tribù " +
  "perché poiché affinché benché finché sennò però perciò andò parlò tornò lasciò cambiò passò restò " +
  "pensò amò baciò cercò trovò sarò farò avrò potrò dovrò vorrò andrò verrò starò dirò darò saprò " +
  "vedrò tornerò cambierò resterò lascerò canterò ballerò morirò dormirò capirò sentirò così lì sì " +
  "lunedì martedì mercoledì giovedì venerdì partì finì capì sentì uscì morì dormì colibrì caffè tè " +
  "né oblò falò cioè ahimè bebè gilè canapè karatè tabù menù"
).split(" ");
const OXYTONE_PLAIN = new Set(COMMON_OXYTONES.map((w) => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "")));

// Words whose final "i/u + vowel" is a hiatus with the stress on the i/u
// ("mio", "follia", "magia") rather than a diphthong ("storia", "piano").
const STRESSED_GLIDE = new Set(
  (
    "mio mia mie tuo tua tue suo sua sue dio zio zia via scia io brio fruscio addio oblio desio " +
    "pendio leggio mormorio rinvio invio avvio follia poesia magia bugia nostalgia energia " +
    "malinconia armonia melodia fantasia gelosia pazzia allegria compagnia ipocrisia anarchia " +
    "galleria osteria pizzeria agonia apatia simpatia empatia sinfonia ironia utopia eresia " +
    "cortesia scortesia frenesia vigliaccheria bugie follie poesie magie fantasie melodie " +
    "polizia geometria economia filosofia biologia tecnologia psicologia ideologia sintonia"
  ).split(" "),
);
const STRESSED_GLIDE_SUFFIX = /(logia|logie|grafia|grafie|sofia|patia|fobia|nomia|metria|crazia|terapia)$/;

interface Nucleus {
  start: number; // index in phoneme string
  end: number; // exclusive
  stressedVowelIndex: number; // index of the main vowel inside phoneme string
  accented: boolean;
}

/** Convert an Italian word to a simplified phoneme string. Uppercase = special consonants. */
export function italianPhonemes(raw: string): { ph: string; accentAt: number } {
  let w = raw.toLowerCase();
  let accentAt = -1;
  let out = "";
  // first pass: strip accents, remember last accented vowel position in the *source*
  let plain = "";
  const accentMarks: boolean[] = [];
  for (const ch of w) {
    if (ACCENTED[ch]) {
      plain += ACCENTED[ch];
      accentMarks.push(true);
    } else if (/[a-z]/.test(ch)) {
      plain += ch;
      accentMarks.push(false);
    }
  }
  w = plain;
  const isV = (c: string | undefined) => !!c && VOWELS.includes(c);

  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const n1 = w[i + 1];
    const n2 = w[i + 2];
    const mark = (len: number) => {
      // carry accent marks of vowels consumed into output
      for (let k = 0; k < len; k++) if (accentMarks[i + k]) accentAt = out.length - 1;
    };
    if (c === "g" && n1 === "l" && n2 === "i") {
      out += "L";
      if (isV(w[i + 3])) {
        i += 2; // drop the i: "figlio" → fiLo
      } else {
        out += "i";
        if (accentMarks[i + 2]) accentAt = out.length - 1;
        i += 2;
      }
      continue;
    }
    if (c === "g" && n1 === "n") {
      out += "N";
      i += 1;
      continue;
    }
    if (c === "s" && n1 === "c" && (n2 === "i" || n2 === "e")) {
      out += "S";
      if (n2 === "i" && isV(w[i + 3])) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if ((c === "c" || c === "g") && n1 === "h") {
      out += c === "c" ? "k" : "g";
      i += 1;
      continue;
    }
    if (c === "c" || c === "g") {
      const soft = c === "c" ? "C" : "G";
      if (n1 === "i" && isV(n2) && !accentMarks[i + 1]) {
        out += soft; // "ciao" → Cao, "giorno" → Gorno
        i += 1;
        continue;
      }
      if (n1 === "e" || n1 === "i") {
        out += soft;
        continue;
      }
      out += c === "c" ? "k" : "g";
      continue;
    }
    if (c === "q") {
      out += "k";
      continue;
    }
    if (c === "h") continue;
    if (c === "x") {
      out += "ks";
      continue;
    }
    if (c === "y" || c === "j") {
      out += "i";
      mark(1);
      continue;
    }
    if (c === "w") {
      out += "v";
      continue;
    }
    if (c === "k") {
      out += "k";
      continue;
    }
    out += c;
    mark(1);
  }
  // doubled soft consonants: "ghiaccio" → giaCCo, "oggi" → oGGi
  out = out.replace(/kC/g, "CC").replace(/gG/g, "GG");
  return { ph: out, accentAt };
}

const isVowel = (c: string) => VOWELS.includes(c);

function findNuclei(ph: string, accentAt: number): Nucleus[] {
  const nuclei: Nucleus[] = [];
  let i = 0;
  while (i < ph.length) {
    if (!isVowel(ph[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < ph.length && isVowel(ph[j])) j++;
    // split vowel run [i, j) into syllable nuclei
    const run = ph.slice(i, j);
    let k = 0;
    while (k < run.length) {
      const a = run[k];
      const b = run[k + 1];
      const c = run[k + 2];
      const abs = i + k;
      const strong = (x: string) => "aeo".includes(x);
      // triphthongs like "uoi", "iei" → one nucleus
      if (b && c && (a === "i" || a === "u") && strong(b) && (c === "i" || c === "u") && accentAt !== abs) {
        nuclei.push({ start: abs, end: abs + 3, stressedVowelIndex: abs + 1, accented: accentAt >= abs && accentAt < abs + 3 });
        k += 3;
        continue;
      }
      if (b) {
        // glide + vowel ("ie", "uo", "ia") — unless the glide carries the accent ("mìo" handled below)
        if ((a === "i" || a === "u") && a !== b && accentAt !== abs) {
          nuclei.push({ start: abs, end: abs + 2, stressedVowelIndex: abs + 1, accented: accentAt === abs + 1 });
          k += 2;
          continue;
        }
        // vowel + glide ("ai", "ei", "au") as falling diphthong, when followed by consonant/end
        if (strong(a) && (b === "i" || b === "u") && !(c && isVowel(c)) && accentAt !== abs + 1) {
          nuclei.push({ start: abs, end: abs + 2, stressedVowelIndex: abs, accented: accentAt === abs });
          k += 2;
          continue;
        }
      }
      // hiatus or single vowel
      nuclei.push({ start: abs, end: abs + 1, stressedVowelIndex: abs, accented: accentAt === abs });
      k += 1;
    }
    i = j;
  }
  return nuclei;
}

function stressIndex(word: string, nuclei: Nucleus[]): number {
  const n = nuclei.length;
  if (n === 0) return -1;
  const acc = nuclei.findIndex((x) => x.accented);
  if (acc >= 0) return acc;
  if (n === 1) return 0;
  if (OXYTONE_WORDS.has(word) || OXYTONE_PLAIN.has(word)) return n - 1;
  if (n >= 3 && (SDRUCCIOLE.has(word) || SDRUCCIOLA_SUFFIX.test(word))) return n - 3;
  // ends in consonant (loanwords, truncations like "amor", "cuor"): stress last
  return n - 2;
}

export function analyzeItalianWord(raw: string): WordPhonology {
  const clean = raw
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^a-zàáâèéêìíîòóôùúûjkwxy]/g, "");
  const base = clean.normalize("NFD").replace(/[̀-ͯ]/g, "");
  let source = clean;
  if (source === base && (STRESSED_GLIDE.has(base) || STRESSED_GLIDE_SUFFIX.test(base))) {
    const m = base.match(/[iu](?=[aeiou]$)/);
    if (m && m.index !== undefined) {
      source = base.slice(0, m.index) + (base[m.index] === "i" ? "ì" : "ù") + base.slice(m.index + 1);
    }
  }
  const { ph, accentAt } = italianPhonemes(source);
  const nuclei = findNuclei(ph, accentAt);
  if (nuclei.length === 0) {
    return { word: raw, phonemes: ph, syllables: 0, stressFromEnd: 0, rhymeKey: ph, vowelTail: "", startsWithVowel: false, endsWithVowel: false, vowels: "" };
  }
  let s = stressIndex(base, nuclei);
  // A word ending in a consonant ("amor", "cuor", "rap") is stressed on the last nucleus.
  if (!isVowel(ph[ph.length - 1]) && nuclei.length > 1 && !nuclei.some((x) => x.accented)) {
    s = nuclei.length - 1;
  }
  const stressed = nuclei[s];
  const rhymeKey = ph.slice(stressed.stressedVowelIndex);
  const vowelsOfNuclei = nuclei.map((x) => ph[x.stressedVowelIndex]).join("");
  const vowelTail = vowelsOfNuclei.slice(s);
  return {
    word: raw,
    phonemes: ph,
    syllables: nuclei.length,
    stressFromEnd: nuclei.length - 1 - s,
    rhymeKey,
    vowelTail,
    vowels: vowelsOfNuclei,
    startsWithVowel: isVowel(ph[0]),
    endsWithVowel: isVowel(ph[ph.length - 1]),
  };
}
