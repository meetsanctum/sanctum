// An answer that asking again won't change, with the status it goes out as.
export class AppRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 500,
  ) {
    super(message);
  }
}
