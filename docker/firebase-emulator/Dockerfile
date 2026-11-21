# Firebase Auth Emulator for local runs. The project id starts with `demo-`, which
# tells the tools this is an emulator-only project: no Google account, no network
# call to a real Firebase project.
FROM node:24-slim
RUN npm install -g firebase-tools@14.27.0 && npm cache clean --force
WORKDIR /srv
COPY firebase.json .
ENV FIREBASE_PROJECT=demo-ex-mio
EXPOSE 9099
CMD ["sh", "-c", "exec firebase emulators:start --only auth --project \"$FIREBASE_PROJECT\" --non-interactive"]
