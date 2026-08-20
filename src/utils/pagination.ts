export interface PaginationInput {
  page?: number | string;
  pageSize?: number | string;
}

export function parsePagination(input: PaginationInput, maxPageSize = 50) {
  const page = Math.max(1, Number(input.page) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(input.pageSize) || 20));
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}
