/**
 * Shared lexicons for the entity guard, the embedding model and the prompt compressor.
 * Internal module: not part of the public contract, safe to extend.
 */

/** canonical company / product name -> aliases (lower-case, matched case-insensitively on word boundaries). */
const ORG_TABLE: Record<string, string[]> = {
  apple: ["apple", "aapl"],
  microsoft: ["microsoft", "msft"],
  google: ["google", "googl", "goog", "alphabet"],
  amazon: ["amazon", "amzn"],
  aws: ["aws"],
  nvidia: ["nvidia", "nvda"],
  snowflake: ["snowflake"],
  tesla: ["tesla", "tsla"],
  meta: ["facebook", "fb"],
  salesforce: ["salesforce"],
  oracle: ["oracle", "orcl"],
  netflix: ["netflix", "nflx"],
  oldcastle: ["oldcastle"],
  postgres: ["postgres", "postgresql", "psql"],
  stripe: ["stripe"],
  openai: ["openai"],
  anthropic: ["anthropic"],
  databricks: ["databricks"],
  shopify: ["shopify"],
  mongodb: ["mongodb", "mongo"],
  redis: ["redis"],
  kafka: ["kafka"],
  mysql: ["mysql"],
  sqlite: ["sqlite"],
  bigquery: ["bigquery"],
  redshift: ["redshift"],
  dynamodb: ["dynamodb"],
  elasticsearch: ["elasticsearch"],
  clickhouse: ["clickhouse"],
  duckdb: ["duckdb"],
  cassandra: ["cassandra"],
  cockroachdb: ["cockroachdb"],
  supabase: ["supabase"],
  firebase: ["firebase"],
  vercel: ["vercel"],
  cloudflare: ["cloudflare"],
  datadog: ["datadog", "ddog"],
  twilio: ["twilio", "twlo"],
  atlassian: ["atlassian"],
  jira: ["jira"],
  github: ["github"],
  gitlab: ["gitlab"],
  docker: ["docker"],
  kubernetes: ["kubernetes", "k8s"],
  terraform: ["terraform"],
  airflow: ["airflow"],
  tableau: ["tableau"],
  looker: ["looker"],
  hubspot: ["hubspot"],
  zendesk: ["zendesk"],
  workday: ["workday", "wday"],
  servicenow: ["servicenow"],
  sap: ["sap"],
  ibm: ["ibm"],
  intel: ["intel", "intc"],
  amd: ["amd"],
  qualcomm: ["qualcomm", "qcom"],
  broadcom: ["broadcom", "avgo"],
  tsmc: ["tsmc"],
  samsung: ["samsung"],
  sony: ["sony"],
  adobe: ["adobe", "adbe"],
  uber: ["uber"],
  lyft: ["lyft"],
  airbnb: ["airbnb", "abnb"],
  doordash: ["doordash"],
  spotify: ["spotify"],
  paypal: ["paypal", "pypl"],
  coinbase: ["coinbase"],
  mastercard: ["mastercard"],
  jpmorgan: ["jpmorgan", "jpm"],
  walmart: ["walmart", "wmt"],
  costco: ["costco"],
  nike: ["nike", "nke"],
  disney: ["disney"],
  palantir: ["palantir", "pltr"],
  crowdstrike: ["crowdstrike", "crwd"],
  okta: ["okta"],
  twitter: ["twitter"],
  linkedin: ["linkedin"],
  tiktok: ["tiktok"],
  alibaba: ["alibaba", "baba"],
  tencent: ["tencent"],
  groq: ["groq"],
  gemini: ["gemini"],
  claude: ["claude"],
  chatgpt: ["chatgpt"],
  gpt: ["gpt"],
  bert: ["bert"],
  llama: ["llama"],
  mistral: ["mistral"],
  cohere: ["cohere"],
  huggingface: ["huggingface"],
  langchain: ["langchain"],
  llamaindex: ["llamaindex"],
  pinecone: ["pinecone"],
  weaviate: ["weaviate"],
  qdrant: ["qdrant"],
  pgvector: ["pgvector"],
  iphone: ["iphone"],
  ipad: ["ipad"],
  macbook: ["macbook"],
  azure: ["azure"],
  gcp: ["gcp"],
  s3: ["s3"],
  ec2: ["ec2"],
};

/** Lower-case alias -> canonical name. */
export const ORG_ALIASES: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(ORG_TABLE)) {
    map.set(canonical, canonical);
    for (const alias of aliases) map.set(alias, canonical);
  }
  return map;
})();

/** Names that are ordinary English words in lower case: folded only when Capitalised or ALL CAPS. */
export const CAPITALISED_ONLY: ReadonlyMap<string, string> = new Map([
  ["meta", "meta"],
  ["slack", "slack"],
  ["zoom", "zoom"],
  ["spark", "spark"],
  ["elastic", "elasticsearch"],
  ["excel", "excel"],
  ["windows", "windows"],
  ["visa", "visa"],
  ["block", "block"],
  ["square", "block"],
  ["target", "target"],
  ["shell", "shell"],
  ["snowpark", "snowpark"],
]);

/** Tickers that collide with English words or generic acronyms: folded only when written ALL CAPS. */
export const CAPS_ONLY_TICKERS: ReadonlyMap<string, string> = new Map([
  ["SNOW", "snowflake"],
  ["CRM", "salesforce"],
  ["META", "meta"],
  ["SHOP", "shopify"],
  ["NOW", "servicenow"],
  ["NET", "cloudflare"],
  ["DASH", "doordash"],
  ["SPOT", "spotify"],
  ["COIN", "coinbase"],
  ["DIS", "disney"],
  ["TEAM", "atlassian"],
  ["ZM", "zoom"],
  ["MDB", "mongodb"],
  ["GS", "goldman sachs"],
]);

/** Multi-word aliases (lower-case, single spaces) -> canonical name. */
export const ORG_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["amazon web services", "aws"],
  ["jpmorgan chase", "jpmorgan"],
  ["jp morgan", "jpmorgan"],
  ["goldman sachs", "goldman sachs"],
  ["morgan stanley", "morgan stanley"],
  ["bank of america", "bank of america"],
  ["wells fargo", "wells fargo"],
  ["berkshire hathaway", "berkshire hathaway"],
  ["home depot", "home depot"],
  ["general motors", "general motors"],
  ["coca cola", "coca-cola"],
  ["coca-cola", "coca-cola"],
  ["hugging face", "huggingface"],
  ["open ai", "openai"],
  ["google cloud", "gcp"],
  ["power bi", "power bi"],
  ["apache kafka", "kafka"],
  ["apache spark", "spark"],
  ["sql server", "sql server"],
  ["vertex ai", "vertex ai"],
];

/** Acronyms that are vocabulary, not entities (upper-case). */
export const ACRONYM_STOPLIST: ReadonlySet<string> = new Set(
  (
    "SQL API APIS JSON PII SLA SLAS SLO SLI LLM LLMS CEO CFO CTO COO CIO CMO VP SVP EVP USD EUR GBP JPY INR CAD AUD " +
    "GPU GPUS CPU CPUS TPU NPU HTTP HTTPS URL URLS URI FAQ AI ML ETL ELT KPI KPIS ARR MRR EBITDA GAAP YOY QOQ MOM YTD " +
    "ROI TTFT TPOT P50 P90 P95 P99 OK OKAY HTML CSS CSV TSV XML YAML YML REST RPC GRPC UUID GUID ID IDS SDK SDKS CLI " +
    "UI UX DB DBS DBA OS VM VMS RAM SSD HDD IO TCP UDP IP DNS TLS SSL SSH JWT SSO RBAC ACID CRUD CTE CTES DDL DML OLAP " +
    "OLTP ORM RAG NLP NLU AGI HR PM QA SRE CI CD PR PRS MVP POC SAAS PAAS IAAS B2B B2C CAC LTV NPS CSAT OKR OKRS TPS QPS " +
    "RPS RPM TPM MAU DAU WAU GMV AOV COGS OPEX CAPEX EPS PE FCF EOD EOW ETA ASAP FYI TBD TBA NA PDF PNG JPG JPEG SVG GIF " +
    "MP4 LGTM IMO IMHO AKA EG IE ETC VS AM UTC PST PDT EST EDT GMT CET IST UTF ASCII MD README ISO GDPR HIPAA SOC PCI DSS " +
    "SOX KYC AML NDA MTTR MTBF RTO RPO CUDA LORA RLHF SFT DPO PPO MOE KV TTL LRU LFU FIFO LIFO CDN WAF VPN VPC IAM ACL " +
    "OAUTH SAML MFA OTP PIN SMS BI DW DWH EDW SLM OCR ASR TTS STT RNN CNN LSTM MLP SVM PCA KNN AUC ROC F1 MSE RMSE MAE " +
    "MAPE NB TL DR TLDR RSVP PS AMA QNA"
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** SQL keywords that should never be read as named entities when written in caps. */
export const SQL_KEYWORDS: ReadonlySet<string> = new Set(
  (
    "SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS ON AS AND OR NOT NULL IS IN GROUP BY ORDER HAVING LIMIT " +
    "OFFSET INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX VIEW WITH UNION ALL ANY EXISTS BETWEEN " +
    "LIKE ILIKE CASE WHEN THEN ELSE END OVER PARTITION ROWS RANGE PRECEDING FOLLOWING CURRENT ROW COUNT SUM AVG MIN MAX " +
    "DISTINCT TRUE FALSE ASC DESC PRIMARY KEY FOREIGN REFERENCES DEFAULT CONSTRAINT UNIQUE CHECK CAST COALESCE NULLIF " +
    "EXPLAIN ANALYZE VACUUM BEGIN COMMIT ROLLBACK GRANT REVOKE TRUNCATE RETURNING USING LATERAL WINDOW QUALIFY INTERVAL " +
    "DATE TIMESTAMP VARCHAR INT INTEGER BIGINT TEXT BOOLEAN NUMERIC DECIMAL FLOAT"
  ).split(/\s+/),
);

/**
 * Common English words never treated as named entities, even when capitalised mid-sentence
 * (title-cased prompts) or written in caps.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set(
  (
    // function words, pronouns, auxiliaries
    "a an the and or but nor so yet if then than that this these those there here where when what which who whom whose " +
    "why how whether while because since until unless although though as at by for from in into of on onto off out over " +
    "under above below to up down with within without about against between among through during before after around " +
    "across along behind beyond near per via i me my mine myself we us our ours you your yours he him his she her hers it " +
    "its they them their theirs is are was were be been being am do does did done doing have has had having can could " +
    "will would shall should may might must ought let lets not no yes all any both each every few many more most much " +
    "other others another some such same own only just also too very really quite rather again ever never always often " +
    "sometimes still already even else instead however therefore thus hence meanwhile otherwise anyway besides " +
    // conversational
    "please thanks thank hi hello hey dear ok okay sure sorry note notes ps fyi " +
    // common verbs
    "show list give find get make create build write explain describe summarize summarise compare analyze analyse " +
    "evaluate review check tell help use using used return returns generate translate calculate compute estimate " +
    "design prove derive refactor fix debug implement add remove delete update insert select provide include exclude " +
    "consider assume suppose imagine draft outline identify extract classify rank sort filter group count convert " +
    "format rewrite improve optimize optimise suggest recommend propose plan predict forecast answer ask need want " +
    "know think see look go run walk start stop keep set put call try read send share save load test verify " +
    // common nouns / adjectives frequently title-cased in prompts
    "step steps example examples question questions answer answers task tasks input output context instructions " +
    "instruction summary table tables query queries data report reports revenue sales profit customer customers user " +
    "users account accounts plan plans product products service services team teams company companies region regions " +
    "market markets year years month months week weeks day days quarter quarters time today tomorrow yesterday new old " +
    "first second third last next previous current total average key important main final best worst good bad high low " +
    "top bottom part section chapter page item items point points option options result results value values number " +
    "numbers name names type types code function functions file files error errors issue issues bug bugs risk risks " +
    "factor factors one two three overview introduction conclusion background objective objectives goal goals"
  ).split(/\s+/),
);

/** Number words -> value (zero..twenty, tens, hundred, thousand, dozen). */
export const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
  ["sixty", 60],
  ["seventy", 70],
  ["eighty", 80],
  ["ninety", 90],
  ["hundred", 100],
  ["thousand", 1000],
  ["dozen", 12],
]);

/** Month names and abbreviations -> 3-letter key. */
export const MONTHS: ReadonlyMap<string, string> = new Map([
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may", "may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sep"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
  ["jan", "jan"],
  ["feb", "feb"],
  ["mar", "mar"],
  ["apr", "apr"],
  ["jun", "jun"],
  ["jul", "jul"],
  ["aug", "aug"],
  ["sep", "sep"],
  ["sept", "sep"],
  ["oct", "oct"],
  ["nov", "nov"],
  ["dec", "dec"],
]);

/** Weekday names -> 3-letter key. */
export const WEEKDAYS: ReadonlyMap<string, string> = new Map([
  ["monday", "mon"],
  ["tuesday", "tue"],
  ["wednesday", "wed"],
  ["thursday", "thu"],
  ["friday", "fri"],
  ["saturday", "sat"],
  ["sunday", "sun"],
]);

/** Single words that carry polarity (used to keep them out of the named-entity rule). */
export const POLARITY_WORDS: ReadonlySet<string> = new Set(
  (
    "not never none nor neither nobody nothing cannot no without excluding exclude excludes excluded except highest " +
    "maximum maximal max most top largest biggest greatest lowest minimum minimal min least bottom smallest fewest " +
    "before after since above over below under increase increases increased increasing rise rises rising rose risen " +
    "grow grows growing grew grown growth decrease decreases decreased decreasing decline declines declined declining " +
    "drop drops dropped dropping fall falls falling fell fallen up down ascending asc descending desc higher lower " +
    "exceed exceeds exceeded exceeding"
  ).split(/\s+/),
);

/** "10-K", "10-Q", "8-K", ... SEC filing types (named entities: a 10-K is not a 10-Q). */
export const SEC_FORM_SOURCE = String.raw`\b(?:10-K|10-Q|8-K|6-K|11-K|S-1|S-3|S-4|20-F|40-F|DEF\s?14A|13F|13D|13G)(?:\/A)?\b`;

/** Escape a literal for use inside a RegExp source. */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
