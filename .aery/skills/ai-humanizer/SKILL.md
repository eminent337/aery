---
name: ai-humanizer
description: Use when analyzing text for AI detection markers, evaluating burstiness or perplexity scores, or rewriting content to evade AI detectors like Scribbr, Turnitin, or QuillBot.
---

# AI Detector & Humanizer (`ai-humanizer`)

## Overview

`ai-humanizer` is a zero-dependency, high-velocity AI detection forensic auditor and humanization engine built following the `leanai` architecture. It models the multi-layer scoring engines of Scribbr, Turnitin, Copyleaks, and QuillBot: calculating **Burstiness ($CV = \sigma / \mu$)**, **Vocabulary Entropy**, **Passive Voice Ratio**, and **Cliché Signatures**.

It provides a global CLI (`ai-humanizer`), a multi-stage rhythm modulation rewriter, and an automated closed-loop verification engine that drives AI detection scores to **0.0%**.

---

## 1. Quick Start (`ai-humanizer` CLI)

Installed globally in `$PATH` at `/home/aryee/.local/bin/ai-humanizer`:

```bash
# 1. Audit text or file with side-by-side before/after comparison
ai-humanizer audit path/to/essay.txt

# 2. Scan text and get leanai-style colored forensic breakdown
ai-humanizer detect "Your text here" [--json]

# 3. Rewrite text into 0%-scoring humanized prose
ai-humanizer rewrite input.txt --out humanized.txt

# 4. View system prompt directives to natively write 0% AI text
ai-humanizer rules
```

---

## 2. The Forensic Model: Why Detectors Flag AI Text

Reverse engineering Scribbr and QuillBot via `leanai` revealed that AI detectors evaluate text on four mathematical dimensions:

| Dimension | AI Text Profile | Human Text Profile | Target Threshold |
| :--- | :--- | :--- | :--- |
| **Burstiness ($CV = \sigma / \mu$)** | Low variance ($CV < 0.25$), uniform 18-22 word sentences. | High variance ($CV \ge 0.55$), short punchy lines mixed with complex clauses. | $CV \ge 0.55$ |
| **Vocabulary Entropy** | High token predictability, repetitive low-entropy choices. | Unpredictable word choices, domain idioms, high lexical entropy. | Entropy $\ge 5.5$ |
| **Cliché Signatures** | Transition adverbs (*"Furthermore"*, *"Moreover"*, *"In conclusion"*), adjectives (*"testament"*, *"delve"*, *"tapestry"*). | Direct claims, conversational connectors (*"Notice that"*, *"Ultimately"*), concrete nouns. | **0 Clichés** |
| **Voice & Syntax** | S-V-O monotony, heavy passive voice, balanced lists of three. | Clause inversions, em-dashes, fragments, active assertions. | Passive $\le 5\%$ |

> [!WARNING]
> **The Free Paraphraser Trap:**
> Scribbr and QuillBot's free humanizers use standard seq2seq synonym swappers (`paraphraser-standard-en-5.1.3`). Their detector explicitly flags QuillBot's own free paraphraser as `AI-PARAPHRASED`, giving it an overall score of **100% AI**. True evasion requires **syntactic rhythm restructuring**, not simple synonym swaps.

---

## 3. The 4 Linguistic Laws for 0% AI Detection

When writing or revising content to pass detectors with 0% AI probability:

### 1. Burstiness Law (Sentence Length Alternation)
Never write consecutive sentences of similar length. Alternate violently:
* Sentence 1 (10 words)
* Sentence 2 (2 words) $\to$ *"That matters."*
* Sentence 3 (24 words with an em-dash `—`)
* Sentence 4 (1 word) $\to$ *"Why?"*
* Sentence 5 (1 word) $\to$ *"Simple."*

### 2. Cliché Eradication
Strip formulaic transition words:
* ❌ *Furthermore / Moreover / Additionally* $\to$ Start directly with the actor or conversational adverbial (*"Today,"*, *"Notice that"*).
* ❌ *In conclusion / In summary* $\to$ *"Ultimately,"* or state the conclusion directly.
* ❌ *Plays a crucial / pivotal role* $\to$ *"Drives"*, *"anchors"*, *"powers"*.
* ❌ *Delve into* $\to$ *"Examine"*, *"explore"*.
* ❌ *A testament to* $\to$ *"Proof of"*, *"shows that"*.
* ❌ *Tapestry / Rich tapestry* $\to$ *"Mix"*, *"mosaic"*.

### 3. Cadence & Contraction Naturalization
* Use natural contractions: *"it's"*, *"don't"*, *"can't"*, *"won't"*, *"there's"*.
* Inject rhetorical breaks: *"In reality? It's messy."*, *"Sounds great on paper."*

### 4. Concrete Physical Grounding
Replace abstract academic generalities with concrete specifics and active verbs.

---

## 4. Architectural Reference
For complete network traces, reverse-engineered payloads, and internal Scribbr/QuillBot schemas, see [scribbr-architecture.md](file:///home/aryee/aery/ai_agent/.agents/skills/ai-humanizer/references/scribbr-architecture.md).
