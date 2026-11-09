import { all, create, type BigNumber, type MathNode } from 'mathjs';

const math = create(all, { number: 'BigNumber', precision: 40, predictable: true });
const limit = math.bignumber('1e1000');
const functions = new Set(['abs', 'sqrt', 'round', 'floor', 'ceil', 'min', 'max', 'log', 'log10', 'exp', 'pow', 'sin', 'cos', 'tan']);
type Node = MathNode & { value?: unknown; name?: string; op?: string; fn?: MathNode; args?: MathNode[]; content?: MathNode };

/** A bounded arithmetic interpreter, not mathjs evaluate/compile. No assignment,
 * accessors, arrays, units, custom functions, persistent scope or JavaScript. */
export function calculate(expression: string): { expression: string; result: string } {
  if (!expression.trim() || expression.length > 1000) throw new Error('Use an expression of 1–1,000 characters.');
  let count = 0;
  function bounded(value: unknown): BigNumber {
    if (!math.isBigNumber(value) || !value.isFinite() || value.abs().gt(limit)) throw new Error('The result must be a finite real number with magnitude at most 1e1000.');
    return value;
  }
  function evaluate(raw: MathNode, depth = 0): BigNumber {
    if (++count > 100 || depth > 16) throw new Error('Simplify the expression: at most 100 operations and 16 levels are supported.');
    const node = raw as Node;
    if (node.type === 'ConstantNode') return bounded(math.bignumber(String(node.value)));
    if (node.type === 'ParenthesisNode') return evaluate(node.content!, depth + 1);
    if (node.type === 'SymbolNode' && ['pi', 'e'].includes(node.name!)) return bounded(node.name === 'pi' ? math.bignumber(math.pi) : math.bignumber(math.e));
    if (!['OperatorNode', 'FunctionNode'].includes(node.type)) throw new Error('Only arithmetic, pi/e and the documented calculator functions are supported.');
    const name = node.type === 'FunctionNode' ? (node.fn as Node)?.name : node.op;
    if (node.type === 'FunctionNode' && ((node.fn as Node)?.type !== 'SymbolNode' || !functions.has(name!))) throw new Error('Supported functions: abs, sqrt, round, floor, ceil, min, max, log, log10, exp, pow, sin, cos, tan.');
    if (node.type === 'OperatorNode' && !['+', '-', '*', '/', '^', '%', 'mod'].includes(name!)) throw new Error('Supported operators: +, -, *, /, ^ and mod.');
    const args = (node.args ?? []).map(arg => evaluate(arg, depth + 1));
    if (!args.length || args.length > 16) throw new Error('Use 1–16 arguments per function.');
    const [a, b] = args;
    const arity = (minimum: number, maximum = minimum) => { if (args.length < minimum || args.length > maximum) throw new Error(`${name} expects ${minimum === maximum ? minimum : `${minimum}–${maximum}`} arguments.`); };
    let result: unknown;
    switch (name) {
      case '+': arity(1, 2); result = b ? math.add(a, b) : a; break;
      case '-': arity(1, 2); result = b ? math.subtract(a, b) : math.unaryMinus(a); break;
      case '*': arity(2); result = math.multiply(a, b); break;
      case '/': arity(2); if (b.isZero()) throw new Error('Division by zero is undefined.'); result = math.divide(a, b); break;
      case '%': case 'mod': arity(2); if (b.isZero()) throw new Error('Modulo by zero is undefined.'); result = math.mod(a, b); break;
      case '^': case 'pow': arity(2); if (b.abs().gt(1000)) throw new Error('Exponents must be between -1000 and 1000.'); result = math.pow(a, b); break;
      case 'abs': arity(1); result = a.abs(); break;
      case 'sqrt': arity(1); result = math.sqrt(a); break;
      case 'round': arity(1, 2); if (b && (!b.isInteger() || b.lt(0) || b.gt(20))) throw new Error('Round uses 0–20 decimal places.'); result = math.round(a, b ? b.toNumber() : 0); break;
      case 'floor': arity(1); result = math.floor(a); break;
      case 'ceil': arity(1); result = math.ceil(a); break;
      case 'min': result = math.min(...args); break;
      case 'max': result = math.max(...args); break;
      case 'log': arity(1, 2); result = b ? math.log(a, b) : math.log(a); break;
      case 'log10': arity(1); result = math.log10(a); break;
      case 'exp': arity(1); if (a.abs().gt(1000)) throw new Error('exp input must be between -1000 and 1000.'); result = math.exp(a); break;
      case 'sin': case 'cos': case 'tan': arity(1); if (a.abs().gt(1000000)) throw new Error('Trigonometric inputs must be within ±1,000,000 radians.'); result = math[name](a); break;
    }
    return bounded(result);
  }
  try {
    const result = evaluate(math.parse(expression));
    return { expression, result: math.format(result, { notation: 'auto', precision: 40, lowerExp: -9, upperExp: 21 }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid expression.';
    throw new Error(message.slice(0, 300));
  }
}
