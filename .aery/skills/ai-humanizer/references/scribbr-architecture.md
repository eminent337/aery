# Scribbr & QuillBot Architecture Inspection Report (leanai Forensics)

This report details the underlying architecture, API schemas, and scoring mechanisms of Scribbr's AI Detector and Humanizer reverse-engineered via `leanai`.

---

## 1. System Topology & Relationship

```
+------------------------------------------------------------------------+
|                                Scribbr                                 |
|                       (Learneo Platform Brand)                         |
+------------------------------------------------------------------------+
                     |                                  |
    [AI Humanizer / Paraphraser]                [AI Content Detector]
                     |                                  |
     Frontend: humanizer-widget.js          Frontend: ai-detector-partner.v1.js
     Host: www.scribbr.com                  Host: quillbot.scribbr.com
                     |                                  |
                     v                                  v
+-----------------------------+       +----------------------------------+
| Scribbr WP-JSON Lite API    |       | QuillBot AI Detector Engine      |
| - /v1/sentence-splitter     |       | - api/ai-detector/score?version=2|
| - /v1/humanize-lite         |       | - Models: prod-4.1.1, v1.1       |
+-----------------------------+       +----------------------------------+
```

* **Corporate Entity**: Scribbr is part of the Learneo group (parent company of QuillBot). [SEEN: `quillbot.com/sdk/ai-detector-partner.v1.js` line 1]
* **AI Detector Engine**: Scribbr delegates all AI detection to QuillBot infrastructure hosted on `quillbot.scribbr.com`.
* **AI Humanizer Engine**: Scribbr hosts a lightweight frontend widget `humanizer-widget.js` that talks to Scribbr's REST API `/wp-json/scribbr/v1/humanize-lite`, which delegates sentence transformations to QuillBot's paraphrasing neural models (`paraphraser-standard-en-5.1.3`).

---

## 2. Scribbr AI Humanizer API Specification

### 2.1 Sentence Splitter
* **Endpoint**: `POST https://www.scribbr.com/wp-json/scribbr/v1/sentence-splitter` [SEEN: `humanizer-widget.js:14`]
* **Headers**:
  ```http
  Content-Type: application/json
  Origin: https://www.scribbr.com
  Referer: https://www.scribbr.com/ai-humanizer/
  User-Agent: Mozilla/5.0 ...
  ```
* **Request Payload**:
  ```json
  {
    "text": "Furthermore, artificial intelligence plays a crucial role in modern healthcare. In conclusion, it offers benefits."
  }
  ```
* **Response Payload**:
  ```json
  {
    "message": "OK",
    "data": {
      "sentences": [
        { "text": "Furthermore, artificial intelligence plays a crucial role in modern healthcare. ", "start": 0, "end": 74 },
        { "text": "In conclusion, it offers benefits.", "start": 75, "end": 109 }
      ],
      "id": "eb9d9729-b34b-476a-a491-7402df4bb984",
      "modelID": "sentence-splitter-en-2.1.2"
    }
  }
  ```

### 2.2 Humanize Sentence (`humanize-lite`)
* **Endpoint**: `POST https://www.scribbr.com/wp-json/scribbr/v1/humanize-lite` [SEEN: `humanizer-widget.js:84`]
* **Request Payload**:
  ```json
  {
    "sent": "Furthermore, artificial intelligence plays a crucial role in modern healthcare.",
    "leftContext": "",
    "rightContext": "In conclusion, it offers benefits.",
    "nBeams": 1,
    "frozenWords": [],
    "preferActive": true,
    "freezeQuotes": false
  }
  ```
* **Response Payload**:
  ```json
  {
    "message": "OK",
    "data": {
      "sent": "Furthermore, artificial intelligence plays a crucial role in modern healthcare.",
      "paras_14": [
        {
          "alt": "Additionally, artificial intelligence is essential to contemporary healthcare.",
          "freezeWordsCoverage": null,
          "isActive": null
        }
      ],
      "id": "1f44c851-2942-49e9-8e86-301eb6fcc236",
      "modelID": "paraphraser-standard-en-5.1.3"
    }
  }
  ```
* **Parameters Insight**:
  * `preferActive: true`: Enforces conversion of passive voice into active voice to break standard LLM passive construction biases.
  * `paras_14`: Mode 14 represents the QuillBot Humanizer fine-tuned paraphrasing beam.

---

## 3. Scribbr / QuillBot AI Detector Engine

### 3.1 Detector API Schema
* **Endpoint**: `POST https://quillbot.scribbr.com/api/ai-detector/score?version=2` [SEEN: `qb-ai-detector-core.js:1124`]
* **Request Payload**:
  ```json
  {
    "text": "The focus of research shifted toward supervisory control...",
    "language": "en",
    "explain": false
  }
  ```
* **Response Payload**:
  ```json
  {
    "message": "OK",
    "traceID": "7430931703005619501",
    "code": "COM_OK",
    "data": {
      "timedOut": false,
      "value": {
        "chunks": [
          {
            "text": "...",
            "startSpan": 0,
            "endSpan": 414,
            "type": "HUMAN" | "AI" | "HUMAN-PARAPHRASED" | "AI-PARAPHRASED",
            "aiScore": 0.0015,
            "humanParaphrasedScore": 0.9565,
            "aiParaphrasedScore": 0.0282
          }
        ],
        "aiScore": 0.85,
        "humanWrittenScore": 0.10,
        "humanParaphrasedScore": 0.03,
        "aiParaphrasedScore": 0.02,
        "id": "bff35804-fc94-11ee-80e1-86def708baba",
        "modelID": "prod-4.1.1",
        "modelVersion": "v1.1"
      }
    },
    "status": 200
  }
  ```

### 3.2 Confidence Calibration
QuillBot evaluates confidence using the formula:
* `aiScore < 70`: **Low** confidence
* `70 <= aiScore < 80`: **Moderate** confidence
* `aiScore >= 80`: **High** confidence [SEEN: `qb-ai-detector-core.js:1134`]

### 3.3 Chunk Categories
1. `HUMAN`: Organic human prose (high perplexity, bursty sentence rhythm).
2. `AI`: Unaltered synthetic text (uniform low perplexity, balanced clause lengths).
3. `HUMAN-PARAPHRASED`: Human text run through a basic synonym swapper.
4. `AI-PARAPHRASED`: AI text lightly rewritten or spun without altering underlying syntactic structure.

---

## 4. Reverse-Engineered Detection Dimensions

1. **Perplexity (Entropy / Predictability)**:
   * Language models calculate conditional probabilities $P(w_t \mid w_1, \dots, w_{t-1})$.
   * AI text clusters tightly around high-likelihood n-grams ($P > 0.85$).
   * Human text routinely contains low-likelihood n-grams ($P < 0.20$), uncommon synonyms, idioms, and unexpected transitions.
2. **Burstiness (Rhythm & Sentence Length Variance)**:
   * Metric: $\sigma / \mu$ (Coefficient of Variation of sentence word counts).
   * AI text: $\sigma / \mu < 0.35$ (monotonic lengths, typically 15–22 words per sentence).
   * Human text: $\sigma / \mu > 0.60$ (erratic lengths, e.g., 4 words followed by 35 words).
3. **Lexical Watermarks & Transition Clichés**:
   * Predictable transition words at sentence starts: *"Furthermore", "Moreover", "In conclusion", "It is worth noting", "Delve", "Pivotal", "Tapestry", "Testament"*.
4. **Syntactic Redundancy**:
   * Repeated sentence starters (e.g., three sentences in a row starting with "The [Noun]").
   * Overuse of passive voice and balanced tripartite lists (*"X, Y, and Z"*).
