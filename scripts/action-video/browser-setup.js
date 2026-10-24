async (page) => {
  // First launch auto-starts the tutorial; mark it seen and reload so the
  // capture starts from the menu.
  const tutorialSeen = await page.evaluate(() => localStorage.getItem('7s-tutorial-seen') !== null);
  if (!tutorialSeen) {
    await page.evaluate(() => localStorage.setItem('7s-tutorial-seen', '1'));
    await page.reload();
  }
  const ageButton = page.getByRole('button', { name: "I'm 13 or older" });
  if (await ageButton.isVisible()) await ageButton.click();

  // Night theme while the battle is generated: the paper theme's noise texture
  // draws from Math.random and would shift the seeded values below.
  const setDayMode = (day) => page.evaluate((wanted) => {
    const toggle = document.getElementById('theme-toggle');
    if (document.body.classList.contains('day-mode') !== wanted) toggle.click();
  }, day);
  await setDayMode(false);
  await page.evaluate(() => {
    const values = [
      0.123,
      0.5, 0.7, 0.5, 0.5, 0.15, 0.2, 0.5, 0.5, 0.75,
      0.8,
      0.45, 0.45, 0.2, 0.2,
      0.65, 0.65, 0.72, 0.6,
      0.9,
      0.1, 0.3, 0.5, 0.7, 0.95,
    ];
    const fallback = Math.random;
    let index = 0;
    Math.random = () => values[index++] ?? fallback();
  });

  await page.getByRole('button', { name: 'vs AI' }).click();
  await page.click('#difficulty-screen [data-difficulty="normal"]');
  await setDayMode(true);
  await page.waitForTimeout(100);
}
