"use strict";

const b64arraybuffer = require("base64-arraybuffer");
const panzoom = require("pan-zoom");
const glMatrix = require("gl-matrix");

const projectionMatrix = glMatrix.mat4.create();
const modelViewMatrix = glMatrix.mat4.create();
const layerViewMatrix = glMatrix.mat4.create();
const inverseMatrix = glMatrix.mat4.create();

const zNear = 0.1;
const zFar = 8;
const fovy = 15.0;

let gl;

let data_size;

let x_position = 0;
let y_position = 0;
let z_position = -zFar;

let uProjectionMatrix;
let uModelViewMatrix;
let uColor;
let aVertexPosition;
let shaderProgram;


window.onload = function init() {

    window.addEventListener("gesturestart", (e) => e.preventDefault());
    window.addEventListener("gesturechange", (e) => e.preventDefault());
    window.addEventListener("gestureend", (e) => e.preventDefault());

    const canvas = document.querySelector("#glcanvas");
    gl = canvas.getContext("webgl");

    if (!gl) {
        console.log("Unable to get webgl context, trying experimental-webgl.");
        gl = canvas.getContext("experimental-webgl");
    }

    if (!gl) {
        alert("Unable to initialize WebGL. Your browser or device may not support it.");
        return;
    }

    gl.getExtension("OES_element_index_uint");
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
        alert("Shader link error: " + gl.getProgramInfoLog(shaderProgram));
        return;
    }

    aVertexPosition = gl.getAttribLocation(shaderProgram, "aVertexPosition");
    uProjectionMatrix = gl.getUniformLocation(shaderProgram, "uProjectionMatrix");
    uModelViewMatrix = gl.getUniformLocation(shaderProgram, "uModelViewMatrix");
    uColor = gl.getUniformLocation(shaderProgram, "uColor");

    data.forEach(function(d) {
        d.s_array = new Uint32Array(d.edge_counts[0]*6);
        let s_array_idx = 0;
        d.e_array = new Uint32Array(d.edge_counts[1]*6);
        let e_array_idx = 0;
        d.n_array = new Uint32Array(d.edge_counts[2]*6);
        let n_array_idx = 0;
        d.w_array = new Uint32Array(d.edge_counts[3]*6);
        let w_array_idx = 0;

        d.p_array = new Float32Array(d.points_count*6);
        const xy_max = Math.max(d.xy_range[0], d.xy_range[1]);
        const z_scale = 1.0 / (xy_max * d.xy_nm_per_unit);
        data_size = [d.xy_range[0]*z_scale, d.xy_range[1]*z_scale];
        let i = 0;
        let state = 0;
        let x = 0;
        let y = 0;
        let x_acc = 0;
        let y_acc = 0;
        let start_x = 0;
        let start_y = 0;
        let start_i = 0;
        let ring_size = 0;
        for (const v of b64_varint_iterator(d.points_str)) {
            switch(state) {
                case 0:
                    ring_size = v;
                    state = 1;
                    break;
                case 1:
                    x_acc += v;
                    x = x_acc / xy_max;
                    start_x = x;
                    state = 2;
                    break;
                case 2:
                    y_acc += v;
                    y = y_acc / xy_max;
                    start_y = y;
                    set_xyz(d.p_array, i, x, y, - d.thickness * z_scale);
                    start_i = i;
                    i += 1;
                    ring_size -= 1;
                    state = 3;
                    break;
                case 3:
                    x_acc += v;
                    const prev_x = x;
                    x = x_acc / xy_max;
                    set_xyz(d.p_array, i, x, y, - d.thickness * z_scale);
                    if (prev_x < x) {
                        s_array_idx = set_side_tris(d.s_array, s_array_idx, i-1, i);
                    } else {
                        n_array_idx = set_side_tris(d.n_array, n_array_idx, i-1, i);
                    }
                    i += 1;
                    ring_size -= 1;
                    if (ring_size == 0) {
                        if (y < start_y) {
                            e_array_idx = set_side_tris(d.e_array, e_array_idx, i-1, start_i);
                        } else {
                            w_array_idx = set_side_tris(d.w_array, w_array_idx, i-1, start_i);
                        }
                        state = 0;
                    } else {
                        state = 4;
                    }
                    break;
                case 4:
                    y_acc += v;
                    const prev_y = y;
                    y = y_acc / xy_max;
                    set_xyz(d.p_array, i, x, y, - d.thickness * z_scale);
                    if (prev_y < y) {
                        e_array_idx = set_side_tris(d.e_array, e_array_idx, i-1, i);
                    } else {
                        w_array_idx = set_side_tris(d.w_array, w_array_idx, i-1, i);
                    }
                    i += 1;
                    ring_size -= 1;
                    if (ring_size == 0) {
                        if (x < start_x) {
                            s_array_idx = set_side_tris(d.s_array, s_array_idx, i-1, start_i);
                        } else {
                            n_array_idx = set_side_tris(d.n_array, n_array_idx, i-1, start_i);
                        }
                        state = 0;
                    } else {
                        state = 3;
                    }
                    break;
            }
        }

        d.p_buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, d.p_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, d.p_array, gl.STATIC_DRAW);

        d.t_array = new Int32Array(d.triangles_points_count);

        let acc = 0;
        let j = 0;
        for (const v of b64_varint_iterator(d.triangles_str)) {
            acc += v;
            d.t_array[j] = acc * 2;
            j += 1;
        }

        d.t_buffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.t_buffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.t_array, gl.STATIC_DRAW);

        if (d.thickness > 0) {
            d.n_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.n_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.n_array, gl.STATIC_DRAW);
            d.s_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.s_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.s_array, gl.STATIC_DRAW);
            d.e_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.e_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.e_array, gl.STATIC_DRAW);
            d.w_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.w_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.w_array, gl.STATIC_DRAW);
        }
    });

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

        const cdx = e.dx / gl.canvas.width  * -2;
        const cdy = e.dy / gl.canvas.height * 2;
        const cdz = e.dz / 700;

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

        x_position = clamp(x_position + odx - ddx, -data_size[0]/2, data_size[0]/2);
        y_position = clamp(y_position + ody - ddy, -data_size[1]/2, data_size[1]/2);

        updateMatrices(gl);

        drawScene(gl);
    });

}


function set_side_tris(ary, ai, from, to) {
    ary[ai] = from*2
    ary[ai+1] = from*2+1
    ary[ai+2] = to*2
    ary[ai+3] = to*2
    ary[ai+4] = from*2+1
    ary[ai+5] = to*2+1
    return ai + 6;
}


function set_xyz(ary, i, x, y, z) {
    ary[i*6] = x;
    ary[i*6+1] = y;
    ary[i*6+2] = 0;
    ary[i*6+3] = x;
    ary[i*6+4] = y;
    ary[i*6+5] = z;
}


function* b64_varint_iterator(b64_string) {
    const varint_data = new DataView(b64arraybuffer.decode(b64_string));
    const varint_encoding = varint_data.getUint8(0)
    let cursor = 1;
    let batch_size = 0;
    let batch_head = 0;
    if (varint_encoding == 0) {
        while (cursor < varint_data.byteLength) {
            if (batch_size == 0) {
                batch_head = varint_data.getUint8(cursor);
                batch_size = 8;
                cursor += 1;
            } else {
                if (batch_head & 0x80) {
                    yield varint_data.getInt16(cursor);
                    cursor += 2;
                } else {
                    yield varint_data.getInt8(cursor);
                    cursor += 1;
                }
                batch_size -= 1;
                batch_head <<= 1;
            }
        }
    } else {
        while (cursor < varint_data.byteLength) {
            if (batch_size == 0) {
                batch_head = varint_data.getUint8(cursor);
                batch_size = 4;
                cursor += 1;
            } else {
                const len = (batch_head & 0xc0) >> 6
                if (len == 3) {
                    yield varint_data.getInt32(cursor);
                    cursor += 4;
                } else if (len == 2) {
                    const upper = varint_data.getInt8(cursor) << 16;
                    cursor += 1;
                    const val = upper | varint_data.getUint16(cursor);
                    yield val;
                    cursor += 2;
                } else if (len == 1) {
                    yield varint_data.getInt16(cursor);
                    cursor += 2;
                } else {
                    yield varint_data.getInt8(cursor);
                    cursor += 1;
                }
                batch_size -= 1;
                batch_head <<= 2;
            }
        }
    }
}


function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        alert("Shader compile error: " + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }

    return shader;
}


function updateMatrices(gl) {
    glMatrix.mat4.perspective(projectionMatrix, fovy * Math.PI / 180, gl.canvas.width / gl.canvas.height, zNear-0.01, zFar+0.001);
    glMatrix.mat4.fromTranslation(modelViewMatrix, [x_position-data_size[0]/2, y_position-data_size[1]/2, z_position]);
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

    data.forEach(function(d) {
        const xy_max = Math.max(d.xy_range[0], d.xy_range[1]);
        const z_scale = 1.0 / (xy_max * d.xy_nm_per_unit);
        glMatrix.mat4.translate(layerViewMatrix, modelViewMatrix, [0, 0, d.elevation*z_scale, 1.0]);
        gl.uniformMatrix4fv(uModelViewMatrix, false, layerViewMatrix);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.p_buffer);
        gl.enableVertexAttribArray(aVertexPosition);
        gl.vertexAttribPointer(aVertexPosition, 3, gl.FLOAT, false, 0, 0);

        const camdist_nm = (-zNear-z_position)/z_scale;
        const oheight_nm = (d.elevation*z_scale-(d.thickness*z_scale/2.0))/z_scale;
        const odist_nm = camdist_nm - oheight_nm;

        let alpha = clamp(odist_nm/500-1.0, 0.0, 1.0);
        if (oheight_nm == 0) {
            alpha = 1.0;
        }
        
        if (d.thickness > 0) {
            gl.uniform4fv(uColor, make_color(d.color, false, 80, alpha));
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.s_buffer);
            gl.drawElements(gl.TRIANGLES, d.edge_counts[0]*6, gl.UNSIGNED_INT, 0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.e_buffer);
            gl.drawElements(gl.TRIANGLES, d.edge_counts[1]*6, gl.UNSIGNED_INT, 0);

            gl.uniform4fv(uColor, make_color(d.color, true, 70, alpha));
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.w_buffer);
            gl.drawElements(gl.TRIANGLES, d.edge_counts[3]*6, gl.UNSIGNED_INT, 0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.n_buffer);
            gl.drawElements(gl.TRIANGLES, d.edge_counts[2]*6, gl.UNSIGNED_INT, 0);
        }

        gl.uniform4fv(uColor, make_color(d.color, true, 0, alpha));
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.t_buffer);
        gl.drawElements(gl.TRIANGLES, d.triangles_points_count, gl.UNSIGNED_INT, 0);
    });
}


function clamp(num, min, max) {
  return num <= min ? min : num >= max ? max : num;
}


window.resizeHandler = function resizeHandler() {
    drawScene(gl);
}
