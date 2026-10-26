/** SigV4 known-answer test against the AWS documentation example
 * (GET /test.txt from examplebucket, 20130524T000000Z). */
import { describe, expect, test } from "bun:test";
import { sigv4Headers } from "../src/bridge/sigv4";

describe("sigv4 known answer", () => {
  test("reproduces the AWS docs GET example signature", () => {
    // 固定时间注入：sigv4Headers 需支持 amzDate 注入（测试专用可选参数）
    // AWS docs "Authenticating Requests (AWS Signature Version 4)" — GET with
    // a Range header, the documented known-answer vector.
    const headers = sigv4Headers({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
      extraSignedHeaders: { range: "bytes=0-9" },
    });
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});
