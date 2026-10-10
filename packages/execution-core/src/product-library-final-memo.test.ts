import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

const {
  assembleAuditedMemo, assertFinalMemoBaseline, assertNavigationSnapshot, finalMemoPreflight, parseIndieAtoms,
  verifyFinalMemoEvidence, writeCanonicalMemo, writeReservedAtom,
} = await import('./product-library-final-memo.mjs');

const roots:string[]=[];
const sha=(value:string|Buffer):string=>createHash('sha256').update(value).digest('hex');
interface PreparedFixture {
  project:{rootPath:string};
  library:{ast:{workflowId:string;workflowVersion:number};finalMemo:{ticker:string;period:string;targetRelativePath:string;cardRelativePath:string;filingRelativePaths:string[];earningsRelativePaths:string[]}};
}
async function fixture():Promise<PreparedFixture>{
  const root=await canonicalTemporaryDirectory('gotzji-final-memo-');roots.push(root);
  for(const directory of ['team-outputs/memos','knowledge-base/atoms','indexes/tickers','knowledge-base']) await mkdir(path.join(root,directory),{recursive:true});
  for(const [name,content] of Object.entries({
    'pipeline.md':'## Active Pipeline\n| Ticker | Stage | Owner | Last Update | Next Action | Notes |\n|---|---|---|---|---|---|\n| TEST | 📇 Card ✅ | Pumpkin | 2026-10-01 | Memo | |\n',
    'indexes/INDEX_outputs.md':'outputs\n','indexes/tickers/TEST.md':'ticker\n','knowledge-base/index.md':'atoms\n','knowledge-base/topic-map.md':'topics\n','knowledge-base/contradiction-registry.md':'# Contradictions\n',
  })) await writeFile(path.join(root,name),content);
  return {project:{rootPath:root},library:{ast:{workflowId:'library.final-memo',workflowVersion:2},finalMemo:{ticker:'TEST',period:'2026-10',targetRelativePath:'team-outputs/memos/TEST_memo_2026-10.md',cardRelativePath:'team-outputs/cards/TEST/Company Overview.md',filingRelativePaths:['team-outputs/filings/TEST_10-Q.md'],earningsRelativePaths:['team-outputs/earnings/TEST-Q2-2026-earnings.md']}}};
}
function draft():string{return `---\ntitle: TEST memo\ndate: 2026-10-07\ntype: memo\ntickers: [TEST]\nrelated:\n  - '[[team-outputs/cards/TEST/Company Overview.md]]'\n---\n\n# Investment Memo TEST\n\n## 🔄 Handoff\n\n- **To:** Facty\n- **Stage transition:** Memo to audit\n- **INDEX consulted:** ticker index\n- **Sources used:** card filing earnings\n- **Key inputs to use:** thesis\n- **Open questions:** none\n- **Pipeline action:** Decision\n- **Index action:** generated\n`;}
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

describe('canonical final memo helpers',()=>{
  it('writes only a non-BLOCK audited memo and refuses duplicate or changed canonical state',async()=>{
    const prepared=await fixture();const preflight=finalMemoPreflight(prepared);
    const mammos={content:draft(),artifactDigest:sha(draft())};const audit='VERDICT: PASS\n\nChecked frozen evidence.';
    const assembled=assembleAuditedMemo(prepared,mammos,{content:audit,artifactDigest:sha(audit),verdict:'PASS'});
    const written=writeCanonicalMemo(prepared,assembled);expect(written.path).toBe('team-outputs/memos/TEST_memo_2026-10.md');
    expect(()=>writeCanonicalMemo(prepared,assembled)).toThrow('LIBRARY_CANONICAL_MEMO_EXISTS');
    await writeFile(path.join(prepared.project.rootPath,'pipeline.md'),'peer changed\n');
    expect(()=>assertFinalMemoBaseline(prepared,preflight,['pipeline'])).toThrow('LIBRARY_CANONICAL_TARGET_CHANGED');
    await writeFile(path.join(prepared.project.rootPath,'indexes/tickers/PEER.md'),'unexpected peer navigation\n');
    expect(()=>assertNavigationSnapshot(prepared,preflight.navigationSnapshot)).toThrow('LIBRARY_NAVIGATION_CHANGED');
    expect(()=>assembleAuditedMemo(prepared,mammos,{content:'VERDICT: BLOCK',artifactDigest:sha('VERDICT: BLOCK'),verdict:'BLOCK'})).toThrow('LIBRARY_FACTY_ARTIFACT_INVALID');
  });

  it('validates structured Indie output, replaces only its reservation, and proves backlinks',async()=>{
    const prepared=await fixture();const audit='VERDICT: CAVEATS\n\nOne narrow caveat.';
    const memo=writeCanonicalMemo(prepared,assembleAuditedMemo(prepared,{content:draft(),artifactDigest:sha(draft())},{content:audit,artifactDigest:sha(audit),verdict:'CAVEATS'}));
    const atoms=parseIndieAtoms({atoms:[{topic:'Demand',thesis:'bull',confidence:'high',content:'อุปสงค์หลักยังเติบโตและมีหลักฐานจาก memo ที่ผ่านการตรวจแล้ว'}]});
    const reservationPath=path.join(prepared.project.rootPath,'knowledge-base/atoms/ATOM-9000-pending.md');const placeholder='reserved';await writeFile(reservationPath,placeholder);
    const atom=writeReservedAtom(prepared,{id:'ATOM-9000',path:reservationPath,sha256:sha(placeholder)},atoms[0],memo);
    await writeFile(path.join(prepared.project.rootPath,'pipeline.md'),'## Active Pipeline\n| Ticker | Stage | Owner | Last Update | Next Action | Notes |\n|---|---|---|---|---|---|\n| TEST | 📊 Memo ✅ | Mammos | 2026-10-07 | ✅ Decision (user) | |\n');
    await writeFile(path.join(prepared.project.rootPath,'indexes/INDEX_outputs.md'),`TEST_memo_2026-10.md\n`);await writeFile(path.join(prepared.project.rootPath,'indexes/tickers/TEST.md'),`TEST_memo_2026-10.md\n`);
    await writeFile(path.join(prepared.project.rootPath,'knowledge-base/index.md'),'ATOM-9000\n');await writeFile(path.join(prepared.project.rootPath,'knowledge-base/topic-map.md'),'ATOM-9000\n');
    expect(verifyFinalMemoEvidence(prepared,memo,[atom])).toMatchObject({verified:true,verdict:'CAVEATS'});
    expect((await readFile(reservationPath,'utf8'))).toContain('tickers: [TEST]');
    expect(()=>parseIndieAtoms({atoms:[]})).toThrow('LIBRARY_INDIE_OUTPUT_INVALID');
  });
});
