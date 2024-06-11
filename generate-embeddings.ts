import { Pool } from 'pg';
import axios from 'axios';
import PQueue from 'p-queue';

const { DATABASE_URL, OPENAI_API_KEY } = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Find yours at https://console.neon.tech');
}

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required. Find yours at https://platform.openai.com');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
});

// The process of generating embeddings can be slow since it requires
// making an API request for each company. To speed things up, we can
// make concurrent requests, but bound by a maximum concurrency limit.
const queue = new PQueue({ concurrency: 3, autoStart: true });

async function createCompaniesTable() {
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        name TEXT,
        slug TEXT,
        website TEXT,
        "smallLogoUrl" TEXT,
        "oneLiner" TEXT,
        "longDescription" TEXT,
        "teamSize" INTEGER,
        url TEXT,
        batch TEXT,
        tags TEXT[],
        status TEXT,
        industries TEXT[],
        regions TEXT[],
        locations TEXT[],
        badges TEXT[],
        embedding VECTOR(1536)
      );
      TRUNCATE TABLE companies RESTART IDENTITY;
    `);
    log('Companies table created successfully');
  } catch (error) {
    log('Error creating companies table:', error);
    process.exit(1);
  }
}

async function scrapeCompanies(url: string) {
  try {
    const response = await axios.get(url);
    const { companies, nextPage, page, totalPages } = response.data;

    log(`Scraping page ${page} of ${totalPages} pages`);

    for (const company of companies) {
      const { longDescription } = company;
      
      queue.add(async () => {
        log(`Generate embedding for company '${company.name}'`);
        const embedding = await generateEmbedding(longDescription);
        
        if (!embedding.length) {
          log(`Skipping company '${company.name}' due to missing embedding`);
        } else {
          await storeCompany(company, embedding);
        }
      });
    }

    // Wait for the queue to be empty before fetching the next page
    await queue.onIdle()

    if (nextPage) {
      log(`Fetching next page of companies: ${nextPage}`)
      await scrapeCompanies(nextPage);
    } else {
      log('All companies scraped successfully');
    }
  } catch (error) {
    log('Error scraping companies:', error);
    process.exit(1);
  }
}

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      {
        input: text,
        model: 'text-embedding-ada-002',
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const { data } = response.data;
    return data[0].embedding;
  } catch (error) {
    log('Error generating embedding:', error);
  }

  return [];
}

async function storeCompany(company: any, embedding: number[]) {
  const {
    name,
    slug,
    website,
    smallLogoUrl,
    oneLiner,
    longDescription,
    teamSize,
    url,
    batch,
    tags,
    status,
    industries,
    regions,
    locations,
    badges,
  } = company;

  try {
    await pool.query(
      `
      INSERT INTO companies (
        name, slug, website, "smallLogoUrl", "oneLiner", "longDescription", "teamSize", url, batch, tags, status, industries, regions, locations, badges, embedding
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `,
      [
        name,
        slug,
        website,
        smallLogoUrl,
        oneLiner,
        longDescription,
        teamSize,
        url,
        batch,
        tags,
        status,
        industries,
        regions,
        locations,
        badges,
        // Convert embedding array to pgvector type, instead of the
        // typical array type that uses curly braces
        `[${embedding.join(',')}]`
      ]
    );

    log(`Company '${name}' stored successfully`);
  } catch (error) {
    log(`Error storing company '${name}':`, error);
    process.exit(1);
  }
}

function log (...args: any[]) {
  args.unshift(new Date(), '-');
  console.log.apply(console, args);
}

async function runScript() {
  await pool.connect();
  await createCompaniesTable();
  await scrapeCompanies('https://api.ycombinator.com/v0.1/companies?page=1');
  await pool.end();
  process.exit(0);
}

runScript();
