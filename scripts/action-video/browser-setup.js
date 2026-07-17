async (page) => {
  const ageButton = page.getByRole('button', { name: "I'm 13 or older" });
  if (await ageButton.isVisible()) await ageButton.click();

  const dayModeCheckbox = page.locator('#day-mode-cb');
  await dayModeCheckbox.uncheck();
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
  await dayModeCheckbox.evaluate((checkbox) => {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(100);
}
