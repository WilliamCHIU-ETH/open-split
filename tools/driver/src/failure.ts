export class DriverFailure extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "DriverFailure";
    this.exitCode = exitCode;
  }
}
