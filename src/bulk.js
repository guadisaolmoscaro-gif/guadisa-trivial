// Lector de preguntas pegadas en bloque.
// Entiende: numeración (1. 1) a) A-), asterisco o tic delante o detrás de la correcta
// (*, ✔, ✓, ✅, [x], "(correcta)"), preguntas separadas por líneas en blanco o sin separar.

const NUM = /^\s*(?:\d+\s*[.)-]|[a-dA-D]\s*[.)]|[-•·]\s+)\s*/

const MARK_START = /^\s*(?:\*|✔|✓|✅|\[x\])\s*/i
const MARK_END = /\s*(?:\*|✔|✓|✅|\[x\]|\(correcta\)|\(correcto\))\s*$/i

const stripNum = (l) => l.replace(NUM, '').trim()

function isMarked(l) {
  return MARK_START.test(l) || MARK_END.test(l)
}

function cleanOption(l) {
  return stripNum(l).replace(MARK_START, '').replace(MARK_END, '').trim()
}

const isQuestionLine = (l) => {
  const s = stripNum(l)
  return /\?\s*$/.test(s) || /^¿/.test(s)
}

// Une las lineas en bloques: uno por pregunta
function splitBlocks(text) {
  const blocks = []
  let cur = []
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l) {
      if (cur.length) { blocks.push(cur); cur = [] }
      continue
    }
    // Si ya hay opciones y aparece otra pregunta sin línea en blanco, empieza bloque nuevo
    const hasOptions = cur.slice(1).length > 0
    if (cur.length && hasOptions && isQuestionLine(l)) {
      blocks.push(cur)
      cur = []
    }
    cur.push(l)
  }
  if (cur.length) blocks.push(cur)
  return blocks
}

const isTF = (o) => /^(verdadero|falso)$/i.test(o)

// Devuelve una lista de preguntas. Cada una trae "error" si hay que revisarla antes de guardar.
export function parseBulk(text) {
  return splitBlocks(text).map((block) => {
    const prompt = stripNum(block[0])
    const rawOpts = block.slice(1)
    const correct = rawOpts.findIndex(isMarked)
    const options = rawOpts.map(cleanOption)
    const item = { prompt, kind: 'multiple', options, correct, error: '' }

    if (!prompt) {
      item.error = 'Falta el texto de la pregunta'
    } else if (options.length === 2 && options.every(isTF)) {
      item.kind = 'truefalse'
      item.options = ['Verdadero', 'Falso']
      item.correct = correct < 0 ? -1 : /^verdadero$/i.test(options[correct]) ? 0 : 1
      if (correct < 0) item.error = 'Falta marcar la respuesta correcta'
    } else if (options.length !== 4) {
      item.error = `Tiene ${options.length} respuestas. Deben ser 4 (o 2 si es verdadero/falso)`
    } else if (correct < 0) {
      item.error = 'Falta marcar la respuesta correcta (con *, ✔ o ✓)'
    } else if (new Set(options.map((o) => o.toLowerCase())).size !== 4) {
      item.error = 'Hay respuestas repetidas'
    }
    return item
  })
}
