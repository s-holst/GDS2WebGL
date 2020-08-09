const b64arraybuffer = require('base64-arraybuffer');
const panzoom = require('pan-zoom');
const glMatrix = require('gl-matrix');

const projectionMatrix = glMatrix.mat4.create();
const modelViewMatrix = glMatrix.mat4.create();
const layerViewMatrix = glMatrix.mat4.create();
const inverseMatrix = glMatrix.mat4.create();

const zNear = 0.3;
const zFar = 10;
const fovy = 15.0;

var x_position = 0;
var y_position = 0;
var z_position = -4;

let uProjectionMatrix;
let uModelViewMatrix;
let uColor;
let aVertexPosition;
let shaderProgram;


window.onload = function init() {

    window.addEventListener('gesturestart', e => e.preventDefault());
    window.addEventListener('gesturechange', e => e.preventDefault());
    window.addEventListener('gestureend', e => e.preventDefault());

    const canvas = document.querySelector('#glcanvas');
    gl = canvas.getContext('webgl');

    if (!gl) {
        console.log('Unable to get webgl context, trying experimental-webgl.');
        gl = canvas.getContext('experimental-webgl');
    }

    if (!gl) {
        alert('Unable to initialize WebGL. Your browser or machine may not support it.');
        return;
    }

    gl.getExtension('OES_element_index_uint');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
        precision mediump float;
        attribute vec4 aVertexPosition;

        varying vec4 fragColor;

        uniform mat4 uModelViewMatrix;
        uniform mat4 uProjectionMatrix;
        uniform vec4 uColor;

        void main() {
            fragColor = uColor;
            gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
        }
    `);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
        precision mediump float;
        varying vec4 fragColor;
        void main() {
            gl_FragColor = fragColor;
        }
    `);

    shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);

    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        alert('Shader link error: ' + gl.getProgramInfoLog(shaderProgram));
        return;
    }
    
    aVertexPosition = gl.getAttribLocation(shaderProgram, 'aVertexPosition');
    uProjectionMatrix = gl.getUniformLocation(shaderProgram, 'uProjectionMatrix');
    uModelViewMatrix = gl.getUniformLocation(shaderProgram, 'uModelViewMatrix');
    uColor = gl.getUniformLocation(shaderProgram, 'uColor');

    for (const d of data) {

        const p_buffer = new DataView(b64arraybuffer.decode(d.p_str));
        d.p_array = new Float32Array(d.p_len*6);
        for (let i = 0; i < d.p_len; i++) {
            const x = p_buffer.getUint16(i*4, true) * 2.0 / (2**16 - 1) - 1
            const y = p_buffer.getUint16(i*4+2, true) * 2.0 / (2**16 - 1) - 1
            d.p_array[i*6] = x;
            d.p_array[i*6+1] = y;
            d.p_array[i*6+2] = 0;
            d.p_array[i*6+3] = x;
            d.p_array[i*6+4] = y;
            d.p_array[i*6+5] = - d.depth * 2;
        }

        d.p_buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, d.p_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, d.p_array, gl.STATIC_DRAW);

        d.t_array = new Int32Array(b64arraybuffer.decode(d.t_str))

        d.t_buffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.t_buffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.t_array, gl.STATIC_DRAW);

        if (d.depth > 0) {
            d.n_array = new Int32Array(b64arraybuffer.decode(d.n_str))

            d.n_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.n_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.n_array, gl.STATIC_DRAW);

            d.s_array = new Int32Array(b64arraybuffer.decode(d.s_str))

            d.s_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.s_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.s_array, gl.STATIC_DRAW);

            d.e_array = new Int32Array(b64arraybuffer.decode(d.e_str))

            d.e_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.e_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.e_array, gl.STATIC_DRAW);

            d.w_array = new Int32Array(b64arraybuffer.decode(d.w_str))

            d.w_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.w_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.w_array, gl.STATIC_DRAW);
        }

    }

    updateMatrices(gl);
    drawScene(gl);

    const vec = glMatrix.vec4.create();
    
    let unpanzoom = panzoom(document.body, e => {
        const cx = e.x / gl.canvas.width  * -2 + 1;
        const cy = e.y / gl.canvas.height * 2 - 1;
        
        glMatrix.vec4.transformMat4(vec, [0.0, 0.0, -z_position, 1.0], projectionMatrix);
        const cz = vec[2]/vec[3];

        glMatrix.vec4.transformMat4(vec, [cx, cy, cz, 1.0], inverseMatrix)
        const ocx = vec[0]/vec[3];
        const ocy = vec[1]/vec[3];
        
        //console.log(`ocx ${ocx.toFixed(2)} ocy ${ocy.toFixed(2)}`);
        
        const cdx = e.dx / gl.canvas.width  * -2;
        const cdy = e.dy / gl.canvas.height * 2;
        const cdz = e.dz / 500;

        glMatrix.vec4.transformMat4(vec, [cx+cdx, cy+cdy, cz, 1.0], inverseMatrix)

        const odx = vec[0]/vec[3] - ocx;
        const ody = vec[1]/vec[3] - ocy;
        
        //console.log(`odx ${odx.toFixed(2)} ody ${ody.toFixed(2)}`);
        
        z_position = clamp(z_position * (1+cdz), -zFar, -zNear);

        glMatrix.vec4.transformMat4(vec, [0.0, 0.0, -z_position, 1.0], projectionMatrix);
        const nz = vec[2]/vec[3];

        updateMatrices(gl);

        glMatrix.vec4.transformMat4(vec, [cx, cy, nz, 1.0], inverseMatrix)
        const nocx = vec[0]/vec[3];
        const nocy = vec[1]/vec[3];

        const ddx = ocx - nocx;
        const ddy = ocy - nocy;
        

        x_position = clamp(x_position + odx - ddx, -1, 1);
        y_position = clamp(y_position + ody - ddy, -1, 1);
        
        updateMatrices(gl);

        drawScene(gl);
    });

}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        alert('Shader compile error: ' + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }

    return shader;
}

function updateMatrices(gl) {
    glMatrix.mat4.perspective(projectionMatrix, fovy * Math.PI / 180, gl.canvas.width / gl.canvas.height, zNear-0.1, zFar+0.001);
    glMatrix.mat4.fromTranslation(modelViewMatrix, [x_position, y_position, z_position]);
    glMatrix.mat4.mul(inverseMatrix, projectionMatrix, modelViewMatrix);
    glMatrix.mat4.invert(inverseMatrix, inverseMatrix);
}

function make_color(base_color, do_lighten, percent, alpha) {
    if (do_lighten) {
        return [
        base_color[0] + (1.0-base_color[0])*percent/100,
        base_color[1] + (1.0-base_color[1])*percent/100,
        base_color[2] + (1.0-base_color[2])*percent/100,
        alpha
        ]
    } else {
        return [
        base_color[0] * (100-percent)/100,
        base_color[1] * (100-percent)/100,
        base_color[2] * (100-percent)/100,
        alpha
        ]
    }
}


function drawScene(gl) {

    const width  = gl.canvas.clientWidth;
    const height = gl.canvas.clientHeight;

    if (gl.canvas.width  != width || gl.canvas.height != height) {
        gl.canvas.width  = width;
        gl.canvas.height = height;
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        updateMatrices(gl);
    }

    // Clear canvas
    gl.clearColor(0.014, 0.086, 0.179, 1.0);  
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(shaderProgram);
    gl.uniformMatrix4fv(uProjectionMatrix, false, projectionMatrix);
    

    for (const d of data) {
        //console.log(d.layer, d.t_cnt)
        glMatrix.mat4.translate(layerViewMatrix, modelViewMatrix, [0, 0, d.z_top*2, 1.0]);
        gl.uniformMatrix4fv(uModelViewMatrix, false, layerViewMatrix);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.p_buffer);
        gl.enableVertexAttribArray(aVertexPosition);
        gl.vertexAttribPointer(aVertexPosition, 3, gl.FLOAT, false, 0, 0);

        //console.log(z_position)

        const camdist = -zNear-z_position;
        const oheight = d.z_top-(d.depth/2);

        let alpha = clamp((camdist-oheight*30)*30, 0, 1);
        if (oheight == 0) {
            alpha = 1;
        }

        //console.log(camdist, oheight, alpha)

        if (d.depth > 0) {
            gl.uniform4fv(uColor, make_color(d.color, false, 80, alpha));
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.s_buffer);
            gl.drawElements(gl.TRIANGLES, d.s_len, gl.UNSIGNED_INT, 0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.e_buffer);
            gl.drawElements(gl.TRIANGLES, d.e_len, gl.UNSIGNED_INT, 0);

            gl.uniform4fv(uColor, make_color(d.color, true, 70, alpha));
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.w_buffer);
            gl.drawElements(gl.TRIANGLES, d.w_len, gl.UNSIGNED_INT, 0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.n_buffer);
            gl.drawElements(gl.TRIANGLES, d.n_len, gl.UNSIGNED_INT, 0);
        }
        
        gl.uniform4fv(uColor, make_color(d.color, true, 0, alpha));
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.t_buffer);
        gl.drawElements(gl.TRIANGLES, d.t_len, gl.UNSIGNED_INT, 0);

    }
}

function clamp(num, min, max) {
  return num <= min ? min : num >= max ? max : num;
}

window.resizeHandler = function resizeHandler() {
    drawScene(gl);
}
