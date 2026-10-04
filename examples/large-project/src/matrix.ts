/**
 * Matrix helpers: pure functions over 2D number grids. No input validation yet,
 * so each exported function is a target for the validation goal.
 */

export function transpose(matrix: number[][]): number[][] {
  return (matrix[0] ?? []).map((_column, index) => matrix.map((row) => row[index] as number));
}

export function scale(matrix: number[][], factor: number): number[][] {
  return matrix.map((row) => row.map((value) => value * factor));
}
