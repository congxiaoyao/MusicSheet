# 简谱翻译 Bug:`letter` 双基准导致升/降号调简谱错位

> 状态:**已修复 (2026-06-19)**
>
> 修复要点:
> 1. KEYS 升号顺序纠正为标准 F C G D A E B(原 G 错成 B);降号纠正为 B E A D G C F
> 2. noteToJianpu 改用「音级中心法」(遍历 7 级找最近半音)算数字,消除 letter 双基准错位
> 3. tonicPc 考虑调号升降(Bb 主音 B 在 flats 里 → 11-1=10)
> 4. letterFromPc 平局偏向上方字母(降号拼写);平局裁决按调号升/降方向
> 5. 八度点 round→floor(C4~B4 同属无点区)
>
> 验证: `npx tsx scripts/verify-jianpu.mjs` 全部 ✅;10 个调 in-key 音阶均输出 1 2 3 4 5 6 7
> 影响范围:除 C 大调外,所有带升降号的调号,简谱数字会错位或临时记号方向错
> 复现脚本:`npx tsx scripts/verify-jianpu.mjs`

## TL;DR

代码里有**两套「字母」系统,基准不同**:
- `KeySig.tonic` / `sharps` / `flats` 用**固定基准**(C=0, D=1, ... B=6)
- `resolvePitch()` 返回的 `letter` 用**调号感知的动态基准**(同一个音在不同调下 letter 不同)

`noteToJianpu` 用 `letter - tonicLetter` 算简谱数字,但 `letter`(动态)和 `tonicLetter`(固定)基准不同,减出来就错位。

## 具体错误例子(实测,2026-06)

跑 `npx tsx scripts/verify-jianpu.mjs` 的当前输出:

### A 大调(C#=3 级,但被算成 2)
| 音 | 正确简谱 | 实际输出 |
|---|---|---|
| C4(A 调里是 C#,3 级) | **3(sharp)** | **2** ❌ 数字错 |
| F4(F#,6 级) | 6(sharp) | 6(flat) ⚠️ 数字对,记号方向错(应是 ♯ 不是 ♭) |
| G4(G#,7 级) | 7(sharp) | 7(flat) ⚠️ 同上 |

### G 大调(只有 F4 错)
| 音 | 正确 | 实际 |
|---|---|---|
| F4(F#,7 级) | 7(sharp) | 7(flat) ⚠️ 数字对,记号方向错 |

### F 大调(只有 B4 错)
| 音 | 正确 | 实际 |
|---|---|---|
| B4(Bb,4 级) | 4(flat) | 4(sharp) ⚠️ 数字对,记号方向错 |

### C 大调:完全正确(无升降号,letter 不被调号扭曲)

## 根因分析

### 系统 A:`KeySig` 的固定基准

`src/core/types.ts` 的 `KeySig` 接口,`tonic`/`sharps`/`flats` 都是固定 C=0 字母索引:

```ts
// src/core/theory.ts KEYS 表
G:  { tonic: 4, sharps: [3] }         // tonic 4 = G; sharps [3] = F
A:  { tonic: 5, sharps: [3, 0, 6] }   // tonic 5 = A; sharps [3,0,6] = F,C,B
```

固定基准:`['C','D','E','F','G','A','B']` = `[0,1,2,3,4,5,6]`。

### 系统 B:`resolvePitch` 的动态基准

`src/core/theory.ts:100-129` 的 `resolvePitch`,在选 letter 时**优先用调号解释**:

```ts
// theory.ts:121-128
} else {
  // 调号优先
  const sharpLetter = key.sharps.find(l => (NATURAL_SEMITONE[l] + 1) % 12 === pc);
  const flatLetter = key.flats.find(l => (NATURAL_SEMITONE[l] + 11) % 12 === pc);
  if (sharpLetter !== undefined) letter = sharpLetter;
  else if (flatLetter !== undefined) letter = flatLetter;
  else letter = letterFromPc(pc);
  accidental = null;
}
```

实测 `resolvePitch(60, 'treble', KEYS.A, null)`(A 调下的 C4):
- C4 的 pc=0
- 遍历 A 调 sharps [3,0,6]:
  - l=6(B):`(NATURAL_SEMITONE[6]+1)%12 = (11+1)%12 = 0` = pc,**匹配!**
  - → letter = 6(把 C4 当成 B#)

**同一个 C4,C 调下 letter=0,A 调下 letter=6。** letter 是调号感知的,不是固定基准。

### 为什么 `noteToJianpu` 算错

```ts
// theory.ts noteToJianpu
digit = (((letter - tonicLetter) % 7) + 7) % 7 + 1
```

- `letter`:系统 B(动态)的值,如 A 调下 C4 = 6
- `tonicLetter`:系统 A(固定)的值,如 A 调 tonic = 5
- 6 - 5 = 1 → digit **2**

但 C4 在 A 大调是 C# = 3 级,应该是 3。**两套基准混用导致错位。**

## 为什么之前没被发现

- 主应用默认 C 大调,没有升降号,letter 不被调号扭曲 → 一直正确
- 测试页连梁用例全是 C 调 → 没触发
- 只有用户切到其它调号(G/D/A/E/B/F#/F/Bb/...)才会暴露
- Eb/Db/Gb 还叠加了 `tonic` 字段本身的错位 bug(已修,但 letter 基准问题仍在)

## 修复建议

### 方案 1(推荐,最小改动):统一 letter 到固定基准

把 `resolvePitch` 的非 forced 分支(theory.ts:121-128)改成直接用固定基准:

```ts
} else {
  letter = letterFromPc(pc);  // 固定基准,不调号感知
  accidental = null;
}
```

**代价**:失去「调号优先的异名同音选择」(比如升号调里 F# 优先用 F# 而非 Gb)。但:
- 简谱场景不需要异名选择(简谱本来就是首调数字 + 临时记号)
- 临时记号的方向(sharp/flat)由 noteToJianpu 另算,不依赖 resolvePitch 的 letter 选择

**验证**:改完跑 `npx tsx scripts/verify-jianpu.mjs`,所有调号都应 ✅。

### 方案 2(彻底):重构两套系统统一

把 KEYS 表也改成调号感知,或把 letter 改成绝对音名 + 单独的调号解释。改动大,不推荐除非要支持异名同音选择。

## 修复后需要顺带做的

1. **改 types.ts:31-33 的过时注释**:明确 `tonic`/`sharps`/`flats` 是固定 C=0 字母索引(现在注释说 pitch-class,与 theory.ts:68 矛盾)
2. **解锁 diagnostics.ts 的 keysig 精细校验**:letter 基准统一后,可补「主音字母 pc == 调名 pc」的校验(代码位置已留好,`diagnoseKeySignature` 函数 + `kind:'keysig'`)
3. **跑回归**:`scripts/verify-jianpu.mjs` 全过 + 连梁测试页不红 + 小星星(C 调)不变

## 相关代码位置

- `src/core/theory.ts:100-129` — resolvePitch(动态 letter 来源)
- `src/core/theory.ts:166-210` — noteToJianpu(混用两个基准,出错处)
- `src/core/theory.ts:31-46` — midiToStaffStep(letter 的另一个用途,step 计算)
- `src/core/theory.ts:52-66` — KEYS 表(固定基准)
- `src/core/types.ts:29-37` — KeySig 接口(过时注释)
- `scripts/verify-jianpu.mjs` — 复现/验证脚本
