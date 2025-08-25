name: Auto Poster System v4.3

on:
  schedule:
    # Morning posts: 9:30, 10:00, 10:45 GMT (5:30, 6:00, 6:45 UTC)
    - cron: '30 5 * * *'
    - cron: '0 6 * * *'
    - cron: '45 6 * * *'
    # Afternoon posts: 13:30, 14:00, 14:45 GMT (9:30, 10:00, 10:45 UTC)
    - cron: '30 9 * * *'
    - cron: '0 10 * * *'
    - cron: '45 10 * * *'
    # Evening posts: 17:30, 18:00, 18:45 GMT (13:30, 14:00, 14:45 UTC)
    - cron: '30 13 * * *'
    - cron: '0 14 * * *'
    - cron: '45 14 * * *'
    # Night posts: 21:30, 22:00, 22:45 GMT (17:30, 18:00, 18:45 UTC)
    - cron: '30 17 * * *'
    - cron: '0 18 * * *'
    - cron: '45 18 * * *'
  workflow_dispatch:

jobs:
  install-dependencies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: |
          npm install --omit=dev --prefer-offline --no-audit --no-fund
      - uses: actions/upload-artifact@v4
        with:
          name: node-modules
          path: node_modules/
          retention-days: 1

  process-posts:
    needs: install-dependencies
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: node-modules
          path: node_modules/
      - name: Run Auto Poster
        env:
          FIREBASE_PROJECT_ID: ${{ secrets.FIREBASE_PROJECT_ID }}
          FIREBASE_PRIVATE_KEY: ${{ secrets.FIREBASE_PRIVATE_KEY }}
          FIREBASE_CLIENT_EMAIL: ${{ secrets.FIREBASE_CLIENT_EMAIL }}
          ZAPIER_WEBHOOKS: ${{ secrets.ZAPIER_WEBHOOKS }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: |
          node src/auto_poster.js
        timeout-minutes: 10

  rotation-check:
    needs: install-dependencies
    if: github.event_name == 'schedule' && startsWith(github.event.schedule, '30 5')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: node-modules
          path: node_modules/
      - name: Check Account Rotation
        env:
          FIREBASE_PROJECT_ID: ${{ secrets.FIREBASE_PROJECT_ID }}
          FIREBASE_PRIVATE_KEY: ${{ secrets.FIREBASE_PRIVATE_KEY }}
          FIREBASE_CLIENT_EMAIL: ${{ secrets.FIREBASE_CLIENT_EMAIL }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: node src/rotation_system.js
        timeout-minutes: 5

  cleanup:
    needs: [process-posts, rotation-check]
    runs-on: ubuntu-latest
    if: always()
    steps:
      - name: Cleanup artifacts
        uses: actions/github-script@v7
        with:
          script: |
            console.log('🧹 تنظيف المؤقتات...');
