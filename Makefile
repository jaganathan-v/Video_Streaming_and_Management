.PHONY: up down restart ps logs scale smoke failover load clean

up:
	docker compose up --build -d

down:
	docker compose down

restart:
	docker compose restart

ps:
	docker compose ps

logs:
	docker compose logs -f

scale:
	docker compose up -d --scale worker=4 --scale api=5
	docker compose restart lb

sample:
	bash scripts/make-sample.sh

smoke:
	bash scripts/smoke-test.sh

failover:
	bash scripts/failover-test.sh

load:
	docker run --rm -i --network host grafana/k6 run - < loadtest/k6-script.js

clean:
	docker compose down -v
	rm -rf samples/*.mp4
