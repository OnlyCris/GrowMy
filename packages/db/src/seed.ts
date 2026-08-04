/**
 * SEED DI SVILUPPO
 *
 * Popola il database con un'organizzazione, due prodotti e una coda di
 * revisione realistica: due brief da approvare e due bozze da revisionare.
 *
 * È idempotente: rieseguirlo azzera e ricrea gli stessi dati con gli stessi
 * id, così l'app in hot reload non perde il riferimento a ciò che stavi
 * guardando.
 *
 *   pnpm db:seed
 *
 * PROTEZIONE: si rifiuta di girare se NODE_ENV è 'production' o se la stringa
 * di connessione non punta a localhost. Un seed che cancella dati eseguito per
 * sbaglio in produzione è un incidente da cui non si torna indietro.
 */
// Deve stare prima di ogni altro import che legga process.env: lo script gira
// come processo Node autonomo, senza il caricamento automatico di Next.js.
import './load-env';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

const CONNECTION_STRING = process.env.DATABASE_URL!;

// --- Barriere di sicurezza -------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  throw new Error('Il seed non può essere eseguito con NODE_ENV=production.');
}

const isLocal =
  CONNECTION_STRING.includes('localhost') ||
  CONNECTION_STRING.includes('127.0.0.1') ||
  CONNECTION_STRING.includes('@postgres:');

if (!isLocal) {
  throw new Error(
    `Il seed accetta solo connessioni locali. Ricevuta: ${CONNECTION_STRING.replace(/:[^:@]+@/, ':***@')}`,
  );
}

// --- Identificatori fissi --------------------------------------------------
// UUID deterministici: il bypass di autenticazione in sviluppo si aspetta
// esattamente DEV_USER_ID, e i link restano validi fra un seed e l'altro.
const USER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000010';
const PRODUCT_FITNESS = '00000000-0000-4000-8000-000000000100';
const PRODUCT_STUDIO = '00000000-0000-4000-8000-000000000101';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING });
  const db = drizzle(pool, { schema });

  console.log('→ Pulizia dei dati esistenti');

  /**
   * TRUNCATE ... CASCADE in un colpo solo: rispetta le foreign key senza
   * doverne calcolare l'ordine a mano, ed è molto più rapido di DELETE.
   * `RESTART IDENTITY` azzera anche le sequenze.
   */
  await db.execute(sql`
    TRUNCATE TABLE
      article_publications, article_versions, articles,
      keywords, keyword_clusters, media_assets, internal_links,
      integrations, product_brand_profiles, products,
      credit_ledger, usage_counters, subscriptions,
      jobs, job_events, audit_logs,
      organization_members, organizations, user_preferences, users
    RESTART IDENTITY CASCADE
  `);

  // -------------------------------------------------------------------------
  // Utente e organizzazione
  // -------------------------------------------------------------------------
  console.log('→ Utente e organizzazione');

  await db.insert(schema.users).values({
    id: USER_ID,
    email: 'dev@growmy.local',
    fullName: 'Utente di sviluppo',
    timezone: 'Europe/Rome',
    locale: 'it',
  });

  await db.insert(schema.userPreferences).values({ userId: USER_ID });

  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: 'Agenzia Demo',
    slug: 'demo',
    ownerId: USER_ID,
  });

  await db.insert(schema.organizationMembers).values({
    organizationId: ORG_ID,
    userId: USER_ID,
    role: 'owner',
  });

  // Crediti: senza, ogni azione che ne riserva uno fallirebbe con
  // INSUFFICIENT_CREDITS e sembrerebbe un bug.
  await db.insert(schema.creditLedger).values({
    organizationId: ORG_ID,
    type: 'grant_promo',
    amount: 100,
    idempotencyKey: `seed-grant-${Date.now()}`,
    description: 'Crediti iniziali di sviluppo',
  });

  // -------------------------------------------------------------------------
  // Prodotti
  // -------------------------------------------------------------------------
  console.log('→ Prodotti');

  await db.insert(schema.products).values([
    {
      id: PRODUCT_FITNESS,
      organizationId: ORG_ID,
      name: 'Acme Fitness',
      domain: 'acmefitness.it',
      websiteUrl: 'https://acmefitness.it',
      status: 'active',
      contentLanguage: 'it-IT',
      timezone: 'Europe/Rome',
      // Revisione umana attiva: è il motivo per cui la coda non è vuota.
      autoApproveBrief: false,
      autoApproveDraft: false,
      approvalTimeoutHours: 48,
      createdBy: USER_ID,
    },
    {
      id: PRODUCT_STUDIO,
      organizationId: ORG_ID,
      name: 'Studio Lenzi',
      domain: 'studiolenzi.it',
      websiteUrl: 'https://studiolenzi.it',
      status: 'active',
      contentLanguage: 'it-IT',
      timezone: 'Europe/Rome',
      autoApproveBrief: false,
      autoApproveDraft: false,
      approvalTimeoutHours: 12,
      createdBy: USER_ID,
    },
  ]);

  await db.insert(schema.productBrandProfiles).values([
    {
      productId: PRODUCT_FITNESS,
      businessSummary:
        'Attrezzatura e programmi di allenamento per chi si allena in casa.',
      targetAudience:
        'Adulti 25-45 anni, poco tempo, spazio domestico limitato, già motivati ma disorientati dalla quantità di informazioni contraddittorie.',
      toneOfVoice:
        'Diretto e concreto. Niente motivazione da poster: numeri, tempi, cose che funzionano.',
      competitorDomains: ['myprotein.it', 'decathlon.it'],
      imageStyle: 'photorealistic',
    },
    {
      productId: PRODUCT_STUDIO,
      businessSummary:
        'Studio commercialista specializzato in partite IVA e regime forfettario.',
      targetAudience:
        'Freelance e piccole imprese che vogliono capire gli obblighi fiscali senza studiare normativa.',
      toneOfVoice:
        'Chiaro e rassicurante. Ogni affermazione ancorata a una norma citabile.',
      imageStyle: 'illustration',
    },
  ]);

  // -------------------------------------------------------------------------
  // Keyword
  // -------------------------------------------------------------------------
  console.log('→ Keyword');

  const keywordRows = await db
    .insert(schema.keywords)
    .values([
      {
        organizationId: ORG_ID,
        productId: PRODUCT_FITNESS,
        term: 'scheda allenamento a casa',
        status: 'processing',
        source: 'ai_research',
        searchVolume: 8_100,
        difficulty: '34.50',
        searchIntent: 'informational',
        priorityScore: '78.00',
        priorityRationale:
          'Volume alto e difficoltà media: è la keyword con il miglior rapporto opportunità/sforzo del cluster.',
      },
      {
        organizationId: ORG_ID,
        productId: PRODUCT_FITNESS,
        term: 'recupero muscolare',
        status: 'processing',
        source: 'gsc_striking_distance',
        searchVolume: 4_400,
        difficulty: '41.20',
        searchIntent: 'informational',
        priorityScore: '86.00',
        priorityRationale:
          'Posizione media 12 su GSC con 340 impressioni al mese: opportunità a portata di mano.',
      },
      {
        organizationId: ORG_ID,
        productId: PRODUCT_STUDIO,
        term: 'crema viso pelle sensibile',
        status: 'processing',
        source: 'competitor_gap',
        searchVolume: 6_600,
        difficulty: '28.90',
        searchIntent: 'commercial',
        priorityScore: '71.00',
        priorityRationale:
          'Due competitor la coprono, noi no: gap identificato dall’analisi comparativa.',
      },
      {
        organizationId: ORG_ID,
        productId: PRODUCT_STUDIO,
        term: 'fattura elettronica forfettari',
        status: 'processing',
        source: 'ai_research',
        searchVolume: 12_100,
        difficulty: '52.30',
        searchIntent: 'informational',
        priorityScore: '91.00',
        priorityRationale:
          'Volume molto alto e intento perfettamente allineato al servizio offerto.',
      },
    ])
    .returning({ id: schema.keywords.id, term: schema.keywords.term });

  const keywordId = (term: string) =>
    keywordRows.find((k) => k.term === term)!.id;

  // -------------------------------------------------------------------------
  // Articoli in attesa di revisione
  // -------------------------------------------------------------------------
  console.log('→ Coda di revisione');

  const briefFitness = {
    angle:
      'Partire dal vincolo reale di chi si allena in casa — lo spazio, non la motivazione — e costruire tre schede per metrature diverse.',
    targetKeyword: 'scheda allenamento a casa',
    secondaryKeywords: ['allenamento senza attrezzi', 'scheda full body casa'],
    sections: [
      {
        id: 'sec-1',
        heading: 'Quanto spazio serve davvero',
        bullets: [
          'Misure minime per gli esercizi a corpo libero più comuni',
          'Cosa si può fare in 4 m² e cosa no',
        ],
        intent: 'informational',
        estimatedWords: 280,
      },
      {
        id: 'sec-2',
        heading: 'Scheda per 4 m²: full body in 30 minuti',
        bullets: [
          'Sette esercizi, tre circuiti, nessun attrezzo',
          'Progressione settimana per settimana',
        ],
        intent: 'informational',
        estimatedWords: 420,
      },
      {
        id: 'sec-3',
        heading: 'Scheda per 10 m²: split su tre giorni',
        bullets: ['Divisione dei gruppi muscolari', 'Volume settimanale consigliato'],
        intent: 'informational',
        estimatedWords: 380,
      },
      {
        id: 'sec-4',
        heading: 'Gli attrezzi che valgono davvero la spesa',
        bullets: [
          'Elastici contro manubri: costo per esercizio disponibile',
          'Cosa comprare per primo con meno di 100 euro',
        ],
        intent: 'commercial',
        estimatedWords: 340,
      },
    ],
    sources: [
      {
        id: 'src-1',
        url: 'https://pubmed.ncbi.nlm.nih.gov/32760116/',
        title: 'Resistance training with minimal equipment: a systematic review',
        reason: 'Dati sull’efficacia comparata degli elastici rispetto ai pesi liberi.',
      },
    ],
    cta: 'Scarica le tre schede in PDF',
    internalLinkTargets: [],
  };

  const briefStudio = {
    angle:
      'Distinguere pelle sensibile da pelle sensibilizzata: è la confusione che porta le persone a comprare il prodotto sbagliato.',
    targetKeyword: 'crema viso pelle sensibile',
    secondaryKeywords: ['pelle reattiva', 'crema lenitiva viso'],
    sections: [
      {
        id: 'sec-1',
        heading: 'Sensibile o sensibilizzata? Non è la stessa cosa',
        bullets: [
          'La prima è costituzionale, la seconda è indotta e reversibile',
          'Come capire in quale delle due categorie rientri',
        ],
        intent: 'informational',
        estimatedWords: 320,
      },
      {
        id: 'sec-2',
        heading: 'Gli ingredienti da evitare',
        bullets: ['Profumazioni e alcol denaturato', 'Perché "naturale" non significa tollerato'],
        intent: 'informational',
        estimatedWords: 400,
      },
      {
        id: 'sec-3',
        heading: 'Come leggere l’INCI in trenta secondi',
        bullets: ['I primi cinque ingredienti sono il prodotto', 'Le sigle che contano'],
        intent: 'informational',
        estimatedWords: 360,
      },
    ],
    sources: [],
    cta: null,
    internalLinkTargets: [],
  };

  const [articleBrief1, articleBrief2, articleDraft1, articleDraft2] = await db
    .insert(schema.articles)
    .values([
      {
        organizationId: ORG_ID,
        productId: PRODUCT_FITNESS,
        keywordId: keywordId('scheda allenamento a casa'),
        status: 'brief_ready',
        brief: briefFitness,
        updatedAt: hoursAgo(2),
      },
      {
        organizationId: ORG_ID,
        productId: PRODUCT_STUDIO,
        keywordId: keywordId('crema viso pelle sensibile'),
        status: 'brief_ready',
        brief: briefStudio,
        // Vicino al timeout di 12 ore: mostra il badge ambra di urgenza.
        updatedAt: hoursAgo(9),
      },
      {
        organizationId: ORG_ID,
        productId: PRODUCT_FITNESS,
        keywordId: keywordId('recupero muscolare'),
        status: 'draft_ready',
        title: 'I 7 errori più comuni nel recupero muscolare',
        slug: 'errori-recupero-muscolare',
        metaDescription:
          'Il recupero muscolare non è riposo passivo. Sette errori che rallentano i progressi e cosa fare al loro posto.',
        wordCount: 1_640,
        // Una metrica sotto soglia: la densità fattuale a 44 è ciò che rende
        // visibile il funzionamento del pannello qualità.
        qualityScore: {
          readability: 74,
          keywordDensity: 61,
          originality: 83,
          factDensity: 44,
          internalLinks: 70,
        },
        updatedAt: hoursAgo(5),
      },
      {
        organizationId: ORG_ID,
        productId: PRODUCT_STUDIO,
        keywordId: keywordId('fattura elettronica forfettari'),
        status: 'draft_ready',
        title: 'Fattura elettronica per forfettari: guida aggiornata 2026',
        slug: 'fattura-elettronica-forfettari-2026',
        metaDescription:
          'Dal 2024 la fattura elettronica è obbligatoria per tutti i forfettari. Come emetterla, quali codici usare, cosa cambia nel 2026.',
        wordCount: 1_890,
        qualityScore: {
          readability: 66,
          keywordDensity: 72,
          originality: 79,
          factDensity: 81,
          internalLinks: 45,
        },
        updatedAt: hoursAgo(26),
      },
    ])
    .returning({ id: schema.articles.id });

  // -------------------------------------------------------------------------
  // Versioni delle bozze
  //
  // Due versioni per il primo articolo: serve ad avere qualcosa da confrontare
  // nella modalità "Differenze" del revisore.
  // -------------------------------------------------------------------------
  console.log('→ Versioni degli articoli');

  const draft1V1 = `## Il recupero non è tempo perso

Molti trattano il giorno di scarico come tempo morto. È un errore.

## Errore 1 — dormire poco

Il sonno è importante per il recupero muscolare.`;

  const draft1V2 = `## Il recupero non è tempo perso

La sintesi proteica muscolare resta elevata per **24-48 ore** dopo una sessione di forza. Chi tratta il giorno di scarico come tempo morto sta ignorando esattamente la finestra in cui l'adattamento avviene.

## Errore 1 — dormire meno di sette ore

Uno studio del 2019 su 31 atleti ha rilevato una riduzione del **23%** nella capacità di produrre forza dopo una sola notte da cinque ore.

Non è una questione di sensazione soggettiva: il deficit è misurabile al dinamometro il mattino dopo.

## Errore 2 — confondere DOMS e danno muscolare

L'indolenzimento che compare 24-48 ore dopo l'allenamento correla male con il danno effettivo. Allenarsi con i DOMS non è pericoloso; allenarsi con una forza ridotta del 20% sì.`;

  const draft2V1 = `## Chi è obbligato

Dal **1 gennaio 2024** l'obbligo di fatturazione elettronica si estende a tutti i contribuenti in regime forfettario, senza più la soglia dei 25.000 euro di ricavi che valeva in precedenza.

## Il codice natura corretto

Per il forfettario il codice da indicare è **N2.2** — operazione non soggetta. Indicare N1 è l'errore che genera più scarti dallo SdI.

## Cosa cambia nel 2026

I termini di conservazione sostitutiva restano a dieci anni.`;

  const version1 = await db
    .insert(schema.articleVersions)
    .values([
      {
        articleId: articleDraft1.id,
        versionNumber: 1,
        contentMarkdown: draft1V1,
        title: 'Errori nel recupero muscolare',
        createdVia: 'ai_generation',
        llmProvider: 'google',
        llmModel: 'gemini-2.0-flash',
      },
      {
        articleId: articleDraft1.id,
        versionNumber: 2,
        contentMarkdown: draft1V2,
        title: 'I 7 errori più comuni nel recupero muscolare',
        metaDescription:
          'Il recupero muscolare non è riposo passivo. Sette errori che rallentano i progressi e cosa fare al loro posto.',
        createdVia: 'ai_rewrite',
        llmProvider: 'google',
        llmModel: 'gemini-2.0-flash',
      },
      {
        articleId: articleDraft2.id,
        versionNumber: 1,
        contentMarkdown: draft2V1,
        title: 'Fattura elettronica per forfettari: guida aggiornata 2026',
        metaDescription:
          'Dal 2024 la fattura elettronica è obbligatoria per tutti i forfettari. Come emetterla, quali codici usare, cosa cambia nel 2026.',
        createdVia: 'ai_generation',
        llmProvider: 'google',
        llmModel: 'gemini-2.0-flash',
      },
    ])
    .returning({
      id: schema.articleVersions.id,
      articleId: schema.articleVersions.articleId,
      versionNumber: schema.articleVersions.versionNumber,
    });

  // Collega ogni articolo alla propria versione corrente.
  const currentOf = (articleId: string) =>
    version1
      .filter((v) => v.articleId === articleId)
      .sort((a, b) => b.versionNumber - a.versionNumber)[0].id;

  await db
    .update(schema.articles)
    .set({ currentVersionId: currentOf(articleDraft1.id) })
    .where(sql`${schema.articles.id} = ${articleDraft1.id}`);

  await db
    .update(schema.articles)
    .set({ currentVersionId: currentOf(articleDraft2.id) })
    .where(sql`${schema.articles.id} = ${articleDraft2.id}`);

  await pool.end();

  console.log(`
✓ Seed completato

  Organizzazione   Agenzia Demo  (slug: demo)
  Utente           dev@growmy.local
  Prodotti         2
  Coda revisione   4 elementi — 2 brief, 2 bozze
  Crediti          100

  Apri:  http://localhost:3000/demo/review
`);

  // Silenzia il warning del linter sugli id non usati oltre l'insert.
  void articleBrief1;
  void articleBrief2;
}

main().catch((error) => {
  console.error('Seed fallito:', error);
  process.exit(1);
});
