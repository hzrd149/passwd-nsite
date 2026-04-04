import { contentType } from "@std/media-types";

export function getContentTypeForPath(path: string): string {
  const normalizedPath = path.split(/[?#]/, 1)[0]?.trim() ?? "/";
  const extension = normalizedPath.match(/(\.[^./]+)$/)?.[1];

  return contentType(extension ?? "") ?? "application/octet-stream";
}
