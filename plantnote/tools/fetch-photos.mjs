// 식물노트 사진 받기: index.html의 식물 목록을 읽어 iNaturalist에서 전체·꽃(열매 식물은 꽃+열매)·잎 사진을 받아
// photos/<분류번호>/ 에 저장하고 photos/index.json 을 만들어요. GitHub Actions에서 실행해요.
// 크리에이티브 커먼즈(CC) 라이선스 사진만 받아요.
// 집에서 키우는 식물(iNaturalist '재배' 기록) 중 배경이 밝은 사진을 먼저 고르고, 없을 때만 야생 사진을 써요.
// 실행 전에 이 폴더에서 npm install 을 해 두면(jpeg-js) 배경 밝기를 재서 골라요.
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

// 품종 이름: 학명의 따옴표 안('Dakota') 또는 괄호 속 영어 품종군(Hybrid Tea)
function cultivarOf(p) {
  const sci = p.sci || "";
  const q = sci.match(/'([^']+)'/);
  if (q) return q[1].trim();
  const g = sci.match(/\(([A-Za-z][^)]*)\)/);
  return g ? g[1].trim() : "";
}
// 학명이 속 단위(Calathea spp., Hoya 등)인 식물만 속 사진을 써요
const genusLevel = p => /\bspp?\.?|등$/.test(p.sci || "") || !/\s/.test(searchName(p));

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
let jpeg = null;
try { jpeg = (await import("jpeg-js")).default; } catch { console.log("jpeg-js가 없어 배경 밝기 없이 골라요 (tools 폴더에서 npm install)"); }
const small = u => u ? u.replace(/\/(square|small|thumb|original|large|medium)\./, "/small.") : null;
// 사진 가장자리(바깥 15%)의 평균 밝기. 흰 벽·밝은 실내 배경일수록 커요
async function edgeBrightness(url) {
  if (!jpeg || !url) return 0;
  const r = await fetch(url);
  if (!r.ok) return 0;
  const { width: w, height: h, data } = jpeg.decode(Buffer.from(await r.arrayBuffer()), { useTArray: true, maxMemoryUsageInMB: 128 });
  const m = Math.floor(Math.min(w, h) * 0.15);
  let sum = 0, n = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (x >= m && x < w - m && y >= m && y < h - m) continue;
    const i = (y * w + x) * 4; sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++;
  }
  return n ? sum / n : 0;
}
async function brightFirst(list) {
  for (const x of list) x.b = await edgeBrightness(x.probe || small(x.url)).catch(() => 0);
  return list.sort((a, b) => b.b - a.b);
}
const medium = u => u ? u.replace(/\/(square|small|thumb|original|large)\./, "/medium.") : null;

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
}

// 검색어와 학명(또는 그 이명)이 정확히 같은 식물 분류군만 써요. 비슷한 이름의 다른 종이나 동물·목(目) 단위가 잡히면 안 돼요
async function findTaxon(name) {
  const want = name.toLowerCase();
  const found = await api(`/taxa?q=${encodeURIComponent(name)}&per_page=30&is_active=true`);
  const plants = (found.results || []).filter(t => t.iconic_taxon_name === "Plantae" && t.rank_level <= 20);
  return plants.find(t => t.name.toLowerCase() === want) || plants.find(t => (t.matched_term || "").toLowerCase() === want) || null;
}
const COMMONS = process.env.COMMONS_API || "https://commons.wikimedia.org/w/api.php";
const norm = x => (x || "").toLowerCase().replace(/[‘’'"]/g, "").replace(/[^a-z0-9가-힣]+/g, " ").trim();
const strip = x => (x || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
// 품종 사진: iNaturalist에서 그 품종 이름을 적은 관찰 기록, 그다음 위키미디어 공용에서 파일 이름에 품종 이름이 들어간 사진
async function cultivarPhotos(t, cv) {
  const want = norm(cv), out = [];
  for (const on of ["names", "tags", "description"]) {
    const d = await api(`/observations?taxon_id=${t.id}&q=${encodeURIComponent(cv)}&search_on=${on}&photos=true&per_page=20&photo_license=${LICENSES}`).catch(() => null);
    for (const o of d?.results || []) {
      const text = norm([o.species_guess, o.description, ...(o.tags || [])].join(" "));
      const ph = o.photos?.find(x => x.license_code);
      if (ph && text.includes(want)) out.push({ url: medium(ph.url), credit: ph.attribution });
    }
  }
  const genus = t.name.split(" ")[0];
  await sleep(DELAY);
  const r = await fetch(`${COMMONS}?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20&gsrsearch=${encodeURIComponent(`"${cv}" ${genus}`)}&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=800`, { headers: { "User-Agent": "plantnote-photo-fetcher" } }).catch(() => null);
  const j = r?.ok ? await r.json().catch(() => null) : null;
  for (const pg of Object.values(j?.query?.pages || {})) {
    const ii = pg.imageinfo?.[0], md = ii?.extmetadata || {};
    const lic = strip(md.LicenseShortName?.value);
    if (!ii || !/jpeg|png/.test(ii.mime || "") || !/cc|public domain|pd/i.test(lic)) continue;
    if (!norm(pg.title).includes(want)) continue;
    out.push({ url: ii.thumburl || ii.url, probe: ii.thumburl, credit: `${strip(md.Artist?.value) || "Wikimedia Commons"}, ${lic}` });
  }
  return out;
}
async function taxonPhotos(name, mode, cv, allowGenus) {
  let t = await findTaxon(name), level = cv ? "cultivar" : "species";
  // 속 단위로 적힌 식물만 속 사진을 써요. 종이 따로 있는 식물에 속 사진을 쓰면 서로 다른 식물이 같은 사진을 갖게 돼요
  if (!t && allowGenus && name.includes(" ")) { t = await findTaxon(name.split(" ")[0]); level = "genus"; }
  if (!t) return null;
  if (cv) {
    const used = new Set(), list = await brightFirst((await cultivarPhotos(t, cv)).filter(x => x.url && !used.has(x.url) && used.add(x.url)));
    if (!list.length) return null;
    const whole = list.slice(0, 2), rest = list.slice(2);
    const flower = mode === "nf" ? [] : rest.splice(0, mode === "fr" ? 1 : 2);
    return { id: t.id, name: `${t.name} '${cv}'`, level, whole, flower, fruit: [], leaf: rest.slice(0, 2) };
  }
  const detail = await api(`/taxa/${t.id}`);
  const tp = (detail.results?.[0]?.taxon_photos || []).map(x => x.photo)
    .filter(ph => ph?.license_code).map(ph => ({ url: medium(ph.medium_url || ph.url), credit: ph.attribution }));
  const toList = d => (d?.results || []).map(o => o.photos?.find(ph => ph.license_code)).filter(Boolean)
    .map(ph => ({ url: medium(ph.url), credit: ph.attribution }));
  // 집·온실에서 키운 기록(captive) 먼저, 배경이 밝은 순서로
  const home = async extra => brightFirst(toList(await api(`/observations?taxon_id=${t.id}&captive=true&photos=true&order_by=votes&per_page=12&photo_license=${LICENSES}${extra}`).catch(() => null)));
  const wild = async extra => toList(await api(`/observations?taxon_id=${t.id}&quality_grade=research&photos=true&order_by=votes&per_page=8&photo_license=${LICENSES}${extra}`).catch(() => null));
  const used = new Set();
  const take = (list, n) => { const out = []; for (const x of list) { if (out.length >= n) break; if (x.url && !used.has(x.url)) { used.add(x.url); out.push(x); } } return out; };
  const homeAll = await home("");
  const whole = take(homeAll, 2);
  if (whole.length < 2) whole.push(...take(tp, 2 - whole.length));
  let flower = [], fruit = [];
  if (mode !== "nf") {
    const fl = (await home("&term_id=12&term_value_id=13")).concat(await wild("&term_id=12&term_value_id=13"));
    flower = take(fl, mode === "fr" ? 1 : 2);
    // 열매: Plant Phenology = Fruiting. 못 찾으면 꽃 사진 1장 더
    if (mode === "fr") {
      fruit = take((await home("&term_id=12&term_value_id=14")).concat(await wild("&term_id=12&term_value_id=14")), 1);
      if (!fruit.length) flower.push(...take(fl, 1));
    }
  }
  let leaf = take((await home("&term_id=36&term_value_id=38")).concat(homeAll), 2);
  if (leaf.length < 2) leaf = leaf.concat(take(await wild("&term_id=36&term_value_id=38"), 2 - leaf.length));
  if (leaf.length < 2) leaf = leaf.concat(take(tp, 2 - leaf.length));
  return { id: t.id, name: t.name, level, whole, flower, fruit, leaf };
}

await fs.mkdir(OUT, { recursive: true });
const indexFile = path.join(OUT, "index.json");
let index = { plants: {}, taxa: {} };
try { index = JSON.parse(await fs.readFile(indexFile, "utf8")); } catch {}
index.plants ||= {}; index.taxa ||= {};

const byName = new Map();
for (const p of PLANTS) {
  const name = searchName(p);
  if (!name || /[가-힣]/.test(name)) { delete index.plants[p.id]; continue; }
  const cv = cultivarOf(p);
  // 품종이 없으면 예전과 같은 열쇠(학명|모드)를 써서 이미 받은 사진을 그대로 써요
  const key = cv ? `${name}|cv:${cv}|${mode(p)}` : `${name}|${mode(p)}`;
  if (!byName.has(key)) byName.set(key, { name, cv, fl: mode(p), genus: genusLevel(p), plants: [] });
  byName.get(key).plants.push(p);
}
const slug = x => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
let done = 0, failed = 0, more = false;
for (const [key, { name, cv, fl, genus, plants }] of byName) {
  try {
    let entry = index.taxa[key];
    if (entry && entry.v !== 2) entry = null;
    if (!entry && Date.now() > DEADLINE) { more = true; break; }
    if (!entry) {
      const t = await taxonPhotos(name, fl, cv, genus);
      if (!t) { index.taxa[key] = { none: true, v: 2 }; for (const p of plants) delete index.plants[p.id]; continue; }
      const dir = path.join(OUT, String(t.id) + (cv ? "-cv-" + slug(cv) : "") + (fl === "f" ? "" : "-" + fl) + "-h");
      await fs.mkdir(dir, { recursive: true });
      entry = { v: 2, taxon: t.name, level: t.level, whole: [], flower: [], fruit: [], leaf: [], credits: [] };
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
    if (entry.none) { for (const p of plants) delete index.plants[p.id]; continue; }
    for (const p of plants) index.plants[p.id] = { taxon: entry.taxon, level: entry.level, whole: entry.whole, flower: entry.flower, fruit: entry.fruit || [], leaf: entry.leaf };
    done++;
    console.log(`✓ ${name}${cv ? ` '${cv}'` : ""} (${plants.length}종)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${e.message}`);
  }
}
// 모두 받았으면 예전 방식으로 받은(이제 아무도 안 쓰는) 사진 폴더를 지워요
if (!more) {
  for (const k of Object.keys(index.taxa)) if (index.taxa[k].v !== 2 || !byName.has(k)) delete index.taxa[k];
  const keep = new Set(Object.values(index.taxa).flatMap(e => ["whole", "flower", "fruit", "leaf"].flatMap(k => (e[k] || []).map(f => f.split("/")[0]))));
  for (const d of await fs.readdir(OUT, { withFileTypes: true })) if (d.isDirectory() && !keep.has(d.name)) await fs.rm(path.join(OUT, d.name), { recursive: true, force: true });
}
await fs.writeFile(indexFile, JSON.stringify(index));
console.log(`완료: ${done}개 학명, 실패 ${failed}개${more ? ", 남은 것은 다음 실행에서 이어 받아요" : ""}`);
if (more && process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "more=true\n");
