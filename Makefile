all:
	npm run build

examples:
	python3 gds2webgl.py -i docs/examples/spm.gds -o docs/examples/spm.html
	python3 gds2webgl.py -i docs/examples/mawson-lakes-org.gds -o docs/examples/mawson-lakes-org.html