describe("Calendar Auth Guard", () => {
  test("redirects to login if token is missing", () => {
    localStorage.removeItem("token");

    require("../../calendar.js");

    expect(window.location.href).toBe("/login");
  });

  test("does not redirect if token exists", () => {
    localStorage.setItem("token", "fakeToken");

    require("../../calendar.js");

    expect(window.location.href).not.toBe("/login");
  });
});