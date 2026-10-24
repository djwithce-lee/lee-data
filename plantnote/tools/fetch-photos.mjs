// 식물노트 사진 받기: index.html의 식물 목록을 읽어 iNaturalist에서 전체·꽃(열매 식물은 꽃+열매)·잎 사진을 받아
// photos/<분류번호>/ 에 저장하고 photos/index.json 을 만들어요. GitHub Actions에서 실행해요.
// 크리에이티브 커먼즈(CC) 라이선스 사진만 받아요.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "photos");
const API = process.env.INAT_BASE || "https://api.inaturalist.org/v1";
const LICENSES = "cc0,cc-by,cc-by-nc,cc-by-sa,cc-by-nc-sa,cc-by-nd,cc-by-nc-nd";
const DELAY = +(process.env.INAT_DELAY_MS ?? 1100);
// 한 번에 너무 오래 돌면 GitHub이 작업을 끊어 받은 사진을 잃으니, 시간이 되면 멈추고 저장한 뒤 다음 실행에서 이어 받아요
const DEADLINE = Date.now() + +(process.env.MAX_MINUTES ?? 100) * 60000;

const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
const start = html.indexOf("const PLANTS = [");
const end = html.indexOf("];\nconst CAT_OF");
const PLANTS = Function(`return ${html.slice(start + "const PLANTS = ".length, end)}]`)();
const setFrom = name => new Set(JSON.parse(html.match(new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\)`))[1]));
const NO_FLOWER = setFrom("NO_FLOWER"), NO_FLOWER_GENUS = setFrom("NO_FLOWER_GENUS"), FRUIT_GENUS = setFrom("FRUIT_GENUS");
// 앱의 hasFlower·hasFruit 와 같은 규칙
const genusOf = p => (p.sci || "").replace(/^×\s*/, "").split(/\s/)[0];
const hasFlower = p => !NO_FLOWER.has(p.id) && !NO_FLOWER_GENUS.has(genusOf(p));
const hasFruit = p => hasFlower(p) && (p.cat === "fruit" || FRUIT_GENUS.has(genusOf(p)) && genusOf(p) !== "Ficus" || /^Ficus carica/.test(p.sci || ""));
const mode = p => !hasFlower(p) ? "nf" : hasFruit(p) ? "fr" : "f";

// 앱과 같은 방식으로 학명에서 종 이름만 뽑아요
function searchName(p) {
  let n = (p.sci || "").split("'")[0].replace(/×/g, " ").replace(/\([^)]*\)/g, "")
    .replace(/\bspp?\.?/g, "").replace(/\b(var|subsp|f)\.\s*\S+/g, "").replace(/등$/, "").replace(/\s+/g, " ").trim();
  return n.split(" ").slice(0, 3).join(" ");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(url) {
  for (let tries = 0; tries < 4; tries++) {
    await sleep(DELAY);
    const r = await fetch(API + url, { headers: { "User-Agent": "plantnote-photo-fetcher" } });
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * (tries + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  throw new Error(`gave up ${url}`);
}
const medium = u => u ? u.replace(/\/(square|small|thumb|original|large)\./, "/medium.") : null;

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
}

async function taxonPhotos(name, mode) {
  const found = await api(`/taxa?q=${encodeURIComponent(name)}&per_page=1`);
  const t = found.results?.[0];
  if (!t) return null;
  const detail = await api(`/taxa/${t.id}`);
  const tp = (detail.results?.[0]?.taxon_photos || []).map(x => x.photo)
    .filter(ph => ph?.license_code).map(ph => ({ url: medium(ph.medium_url || ph.url), credit: ph.attribution }));
  const obs = async extra => {
    const d = await api(`/observations?taxon_id=${t.id}&photos=true&quality_grade=research&order_by=votes&per_page=8&photo_license=${LICENSES}${extra}`);
    return (d.results || []).map(o => o.photos?.find(ph => ph.license_code)).filter(Boolean)
      .map(ph => ({ url: medium(ph.url), credit: ph.attribution }));
  };
  const used = new Set();
  const take = (list, n) => { const out = []; for (const x of list) { if (out.length >= n) break; if (x.url && !used.has(x.url)) { used.add(x.url); out.push(x); } } return out; };
  const whole = take(tp, 2);
  const flowerObs = mode === "nf" ? [] : await obs("&term_id=12&term_value_id=13").catch(() => []);
  const flower = take(flowerObs, mode === "fr" ? 1 : 2);
  // 열매: Plant Phenology = Fruiting. 못 찾으면 꽃 사진 1장 더
  const fruit = mode === "fr" ? take(await obs("&term_id=12&term_value_id=14").catch(() => []), 1) : [];
  if (mode === "fr" && !fruit.length) flower.push(...take(flowerObs, 1));
  let leaf = take(await obs("&term_id=36&term_value_id=38").catch(() => []), 2);
  if (leaf.length < 2) leaf = leaf.concat(take(tp, 2 - leaf.length));
  return { id: t.id, name: t.name, whole, flower, fruit, leaf };
}

await fs.mkdir(OUT, { recursive: true });
const indexFile = path.join(OUT, "index.json");
let index = { plants: {}, taxa: {} };
try { index = JSON.parse(await fs.readFile(indexFile, "utf8")); } catch {}
index.plants ||= {}; index.taxa ||= {};

const byName = new Map();
for (const p of PLANTS) {
  const name = searchName(p);
  if (!name || /[가-힣]/.test(name)) continue;
  const key = `${name}|${mode(p)}`;
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(p);
}
let done = 0, failed = 0, more = false;
for (const [key, plants] of byName) {
  const [name, fl] = key.split("|");
  try {
    let entry = index.taxa[key];
    if (!entry && Date.now() > DEADLINE) { more = true; break; }
    if (!entry) {
      const t = await taxonPhotos(name, fl);
      if (!t) { index.taxa[key] = { none: true }; continue; }
      const dir = path.join(OUT, String(t.id) + (fl === "f" ? "" : "-" + fl));
      await fs.mkdir(dir, { recursive: true });
      entry = { taxon: t.name, whole: [], flower: [], fruit: [], leaf: [], credits: [] };
      for (const kind of ["whole", "flower", "fruit", "leaf"]) {
        for (let i = 0; i < t[kind].length; i++) {
          const rel = `${path.basename(dir)}/${kind}${i + 1}.jpg`;
          await download(t[kind][i].url, path.join(OUT, rel));
          entry[kind].push(rel);
          entry.credits.push(t[kind][i].credit);
        }
      }
      index.taxa[key] = entry;
      await fs.writeFile(indexFile, JSON.stringify(index));
    }
    if (entry.none) continue;
    for (const p of plants) index.plants[p.id] = { taxon: entry.taxon, whole: entry.whole, flower: entry.flower, fruit: entry.fruit || [], leaf: entry.leaf };
    done++;
    console.log(`✓ ${name} (${plants.length}종)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${e.message}`);
  }
}
await fs.writeFile(indexFile, JSON.stringify(index));
console.log(`완료: ${done}개 학명, 실패 ${failed}개${more ? ", 남은 것은 다음 실행에서 이어 받아요" : ""}`);
if (more && process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "more=true\n");
