/**
 * CURVA CTR PER POSIZIONE
 *
 * Serve a rispondere a una sola domanda, che è quella su cui si regge tutto il
 * planner: *quanto vale davvero salire di posizione su questa query?*
 *
 * Senza una curva, "posizione 12" e "posizione 9" sembrano problemi simili. Non
 * lo sono: la nona posizione è in prima pagina e la dodicesima no, e il salto
 * di CTR fra le due è più grande del salto fra la terza e la sesta. Ordinare le
 * opportunità per sole impression ignora questo, e produce una lista di lavoro
 * dominata da query ad alto volume su cui non ci muoveremo mai.
 *
 * I VALORI SONO STIME, e vanno letti come tali. Derivano dagli studi pubblici
 * aggregati sul CTR organico (Advanced Web Ranking, Sistrix e simili): il CTR
 * reale dipende da SERP feature, intento e brand, e varia molto per settore.
 * Li usiamo per ORDINARE le opportunità fra loro, non per promettere numeri
 * all'utente — è la ragione per cui il guadagno stimato viene mostrato in UI
 * come "stima", mai come previsione.
 */

/** CTR medio atteso per posizione, dalla 1 alla 20. */
const CTR_BY_POSITION: readonly number[] = [
  0.275, // 1
  0.152, // 2
  0.099, // 3
  0.071, // 4
  0.053, // 5
  0.04, // 6
  0.031, // 7
  0.025, // 8
  0.021, // 9
  0.018, // 10  — ultima della prima pagina
  0.011, // 11  — il crollo della seconda pagina
  0.01, // 12
  0.009, // 13
  0.008, // 14
  0.008, // 15
  0.007, // 16
  0.007, // 17
  0.006, // 18
  0.006, // 19
  0.005, // 20
];

/**
 * CTR atteso a una data posizione media.
 *
 * Interpola fra i due interi adiacenti: una posizione media di 8,4 non è né la
 * ottava né la nona, e arrotondare introdurrebbe scalini artificiali proprio
 * nella fascia che stiamo analizzando.
 */
export function expectedCtrAtPosition(position: number): number {
  if (!Number.isFinite(position) || position < 1) return CTR_BY_POSITION[0];
  if (position >= CTR_BY_POSITION.length) {
    // Oltre la ventesima il CTR è residuo e sostanzialmente piatto.
    return CTR_BY_POSITION[CTR_BY_POSITION.length - 1];
  }

  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerCtr = CTR_BY_POSITION[lower - 1];
  if (lower === upper) return lowerCtr;

  const upperCtr = CTR_BY_POSITION[upper - 1];
  const fraction = position - lower;
  return lowerCtr + (upperCtr - lowerCtr) * fraction;
}

/**
 * Posizione obiettivo realistica per una query in striking distance.
 *
 * Non la prima: promettere il primo posto per qualunque query è esattamente il
 * tipo di stima che rende inutilizzabile un cruscotto. La terza è il traguardo
 * plausibile per una pagina che è già fra l'ottava e la ventesima e riceve un
 * intervento editoriale serio.
 */
export const REALISTIC_TARGET_POSITION = 3;

/** Clic mensili aggiuntivi stimati salendo alla posizione obiettivo. */
export function estimatedClickGain(params: {
  impressions: number;
  currentPosition: number;
  targetPosition?: number;
}): number {
  const target = params.targetPosition ?? REALISTIC_TARGET_POSITION;
  // Salire non può peggiorare: se è già meglio dell'obiettivo, il guadagno è 0.
  if (params.currentPosition <= target) return 0;

  const delta =
    expectedCtrAtPosition(target) - expectedCtrAtPosition(params.currentPosition);

  return Math.max(0, Math.round(params.impressions * delta));
}
