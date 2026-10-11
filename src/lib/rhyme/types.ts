export interface WordPhonology {
  word: string;
  /** simplified phoneme string */
  phonemes: string;
  syllables: number;
  /** 0 = stress on last syllable (tronca), 1 = penultimate (piana), 2 = antepenultimate (sdrucciola) */
  stressFromEnd: number;
  /** sounds from the stressed vowel to the end — equal keys = perfect rhyme */
  rhymeKey: string;
  /** vowels from the stressed vowel to the end — equal = assonance */
  vowelTail: string;
  /** vowel of every syllable nucleus, in order */
  vowels: string;
  startsWithVowel: boolean;
  endsWithVowel: boolean;
}

export type RhymeQuality = "identical" | "perfect" | "assonance" | "consonance" | "none";

export interface RhymeMatch {
  quality: RhymeQuality;
  /** 0..1 */
  score: number;
  /** number of matching vowel sounds going back from the line end (multisyllabic rhyme depth) */
  depth: number;
}

export interface LineAnalysis {
  /** sung/metric syllables (with synalepha for Romance languages) */
  syllables: number;
  lastWord: string;
  rhymeKey: string;
  vowelTail: string;
  /** vowel sequence of the whole line, used for multisyllabic rhyme depth */
  lineVowels: string;
  stressFromEnd: number;
}

export interface RhymeWord {
  word: string;
  syllables: number;
}

export interface RhymeResult {
  word: string;
  rhymeKey: string;
  perfect: RhymeWord[];
  near: RhymeWord[];
  source: string;
}
